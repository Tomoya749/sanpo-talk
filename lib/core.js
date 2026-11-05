// functions/lib/core.js をブラウザ用に変換したもの(github/build.py で作成)

// 会話の中継サーバーの中核ロジック。外部パッケージに依存しないので、
// `npm test` だけで単体テストできる。Firebase との接続は ../index.js、
// Cloudflare Workers 版は ../../cloudflare/build.py がこのファイルを取り込んで作る。

const OPENAI_URL = "https://api.openai.com/v1/responses";

const LIMITS = Object.freeze({
  historyItems: 12, // AI に渡す直近の発言数
  textChars: 400, // 1発言あたりの最大文字数
  bodyChars: 20000, // リクエスト全体の最大文字数
  replyChars: 160, // 読み上げる返事の最大文字数
});

const RULES = [
  "返事は音声で読み上げられます。1〜2文、合わせて60文字くらいまでの短い話し言葉にしてください。",
  "絵文字、顔文字、記号、箇条書き、かっこ書き、(笑)のようなト書きは使わないでください。",
  "話題は自由です。ユーザーの話にしっかり反応し、ときどき質問を返して会話を続けてください。",
  "画面を見るよう促さないでください。ときどき、足元や車に気をつけるよう声をかけてもかまいません。",
  "健康や体調について、診断や治療の助言はしません。体調が悪そうなときは、無理せず休むよう伝えてください。",
  "暴力的・性的・差別的な話題には乗らず、やんわりと話を変えてください。",
  "ユーザーが本気でAIかどうかを聞いたときは、AIのキャラクターだと正直に答えてください。",
  "キャラクターの口調と性格を最後まで保ってください。",
];

const MODES = Object.freeze({
  greeting: () =>
    "散歩が始まったところです。出発のあいさつはもう済んでいます。時間帯や季節に合った話題で、最初のひとことを話しかけてください。",
  milestone: (stats) =>
    `歩数が${formatNumber(stats.milestone ?? stats.steps)}歩に届きました。そのことに自然にふれて、軽くほめてください。そのあと、ちょっとした話題をふってもかまいません。`,
  chat: () => "ユーザーの最後の発言に返事をしてください。",
  summary: () =>
    "散歩が終わりました。今日の歩数と時間にふれてねぎらい、次の散歩が楽しみになるひとことを添えてください。2文以内で話してください。",
});

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class UpstreamError extends Error {
  constructor(status, body) {
    super(`OpenAI API error ${status}`);
    this.status = status;
    this.body = String(body ?? "").slice(0, 500);
  }
}

function formatNumber(n) {
  return Number(n).toLocaleString("ja-JP");
}

function partOfDay(hour) {
  if (hour < 4) return "深夜";
  if (hour < 10) return "朝";
  if (hour < 16) return "昼";
  if (hour < 19) return "夕方";
  return "夜";
}

function intIn(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeStats(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const localTime =
    typeof s.localTime === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.localTime)
      ? s.localTime
      : null;
  return {
    steps: intIn(s.steps, 0, 200000) ?? 0,
    distanceMeters: intIn(s.distanceMeters, 0, 200000) ?? 0,
    minutes: intIn(s.minutes, 0, 1440) ?? 0,
    milestone: intIn(s.milestone, 0, 200000),
    localTime,
  };
}

function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "bad_request", "JSONのオブジェクトを送ってください");
  }
  if (JSON.stringify(body).length > LIMITS.bodyChars) {
    throw new HttpError(413, "too_large", "リクエストが大きすぎます");
  }
  const mode = body.mode;
  if (typeof mode !== "string" || !Object.hasOwn(MODES, mode)) {
    throw new HttpError(400, "bad_mode", "mode が正しくありません");
  }
  if (body.history !== undefined && !Array.isArray(body.history)) {
    throw new HttpError(400, "bad_history", "history は配列で送ってください");
  }
  const history = [];
  for (const item of (body.history ?? []).slice(-LIMITS.historyItems)) {
    if (
      !item ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.text !== "string"
    ) {
      throw new HttpError(400, "bad_history", "history の形式が正しくありません");
    }
    const text = item.text.trim();
    if (!text) continue;
    if (text.length > LIMITS.textChars) {
      throw new HttpError(400, "text_too_long", "発言が長すぎます");
    }
    history.push({ role: item.role, text });
  }
  if (mode === "chat" && (history.length === 0 || history.at(-1).role !== "user")) {
    throw new HttpError(400, "no_user_message", "chat では最後の発言がユーザーのものである必要があります");
  }
  return { mode, history, stats: normalizeStats(body.stats) };
}

function describeStats(stats) {
  const lines = [];
  if (stats.localTime) {
    const hour = Number(stats.localTime.split(":")[0]);
    lines.push(`- 時刻: ${stats.localTime}(${partOfDay(hour)})`);
  }
  lines.push(`- 散歩を始めてから: ${stats.minutes}分`);
  lines.push(`- 歩数: ${formatNumber(stats.steps)}歩(GPSの移動距離から推定)`);
  lines.push(`- 距離: 約${(stats.distanceMeters / 1000).toFixed(1)}km`);
  return lines;
}

function modeInstruction(mode, stats) {
  return MODES[mode](stats);
}

function buildInstructions(character, mode, stats) {
  return [
    `あなたは散歩アプリのキャラクター「${character.name}」です。ユーザーと一緒に散歩しながら、イヤホン越しに音声で話しています。`,
    "",
    "# キャラクター",
    character.persona.trim(),
    "",
    "# 話し方のルール",
    ...RULES.map((rule) => `- ${rule}`),
    "",
    "# いまの状況",
    ...describeStats(stats),
    "",
    "# 今回の役割",
    modeInstruction(mode, stats),
  ].join("\n");
}

function buildInput(mode, history, stats) {
  const input = history.map((h) => ({ role: h.role, content: h.text }));
  // 会話以外(あいさつ・歩数の節目・まとめ)では、最後に役割を明示して次の発言を促す
  if (mode !== "chat") {
    input.push({ role: "developer", content: modeInstruction(mode, stats) });
  }
  return input;
}

function extractText(json) {
  if (!json || typeof json !== "object") return "";
  if (typeof json.output_text === "string" && json.output_text) return json.output_text;
  const parts = [];
  for (const item of Array.isArray(json.output) ? json.output : []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

// 読み上げに向かない文字を取り除き、長すぎる返事を文の切れ目で短くする
function cleanForSpeech(text) {
  let t = String(text ?? "");
  t = t.replace(/[（(][^（）()]{0,20}[）)]/g, "");
  t = t.replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u{FE0F}\u{200D}]/gu, "");
  t = t.replace(/[*#_`>~|「」『』]/g, "");
  t = t.replace(/\s*\n+\s*/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > LIMITS.replyChars) {
    const head = t.slice(0, LIMITS.replyChars);
    const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("!"), head.lastIndexOf("?"));
    t = cut > 20 ? head.slice(0, cut + 1) : head;
  }
  return t;
}

function estimateCost(usage, env) {
  const inPrice = Number(env.PRICE_INPUT_PER_M ?? 0.1);
  const outPrice = Number(env.PRICE_OUTPUT_PER_M ?? 0.5);
  const cost = (usage.inputTokens * inPrice + usage.outputTokens * outPrice) / 1e6;
  return Number.isFinite(cost) ? Math.round(cost * 1e8) / 1e8 : 0;
}

async function callOpenAI({
  apiKey,
  model,
  effort,
  instructions,
  input,
  maxOutputTokens = 400,
  fetchImpl = fetch,
  timeoutMs = 15000,
}) {
  const body = { model, instructions, input, max_output_tokens: maxOutputTokens, store: false };
  if (effort && effort !== "default") body.reasoning = { effort };

  const send = (payload) =>
    fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let res = await send(body);
  if (res.status === 400 && body.reasoning) {
    const errText = await res.text();
    // モデルがこの推論設定に対応していない場合は、設定を外して1回だけやり直す
    if (!/reasoning|effort/i.test(errText)) throw new UpstreamError(400, errText);
    const { reasoning: _omit, ...withoutReasoning } = body;
    res = await send(withoutReasoning);
  }
  if (!res.ok) throw new UpstreamError(res.status, await res.text());

  const json = await res.json();
  return {
    text: extractText(json),
    usage: {
      inputTokens: Number(json?.usage?.input_tokens ?? 0),
      outputTokens: Number(json?.usage?.output_tokens ?? 0),
    },
    model: json?.model ?? model,
    status: json?.status ?? "completed",
  };
}

function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) hits.clear();
      return true;
    },
  };
}

// 合言葉の比べ方で中身を推測されないよう、長さが同じなら最後まで比べる。
// Node と Cloudflare Workers の両方で動くように、Node 専用の機能は使わない
function accessAllowed(expected, provided) {
  if (!expected || expected === "none") return true;
  if (typeof provided !== "string") return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function handleChat({
  method,
  body,
  headers = {},
  ip = "unknown",
  env,
  character,
  limiter,
  fetchImpl = fetch,
}) {
  try {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "POSTで送ってください");
    if (!accessAllowed(env.ACCESS_CODE, headers["x-access-code"])) {
      throw new HttpError(401, "access_denied", "合言葉が違います");
    }
    if (limiter && !limiter.allow(ip)) {
      throw new HttpError(429, "rate_limited", "リクエストが多すぎます。少し待ってから試してください");
    }
    if (!env.OPENAI_API_KEY) {
      throw new HttpError(500, "not_configured", "OPENAI_API_KEY が設定されていません");
    }

    const { mode, history, stats } = validateRequest(body);
    const started = Date.now();
    const result = await callOpenAI({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-6-luna",
      effort: env.REASONING_EFFORT ?? "none",
      instructions: buildInstructions(character, mode, stats),
      input: buildInput(mode, history, stats),
      maxOutputTokens: intIn(env.MAX_OUTPUT_TOKENS, 50, 4000) ?? 400,
      fetchImpl,
    });

    const text = cleanForSpeech(result.text);
    if (!text) throw new HttpError(502, "empty_reply", "AIの返事が空でした");

    return {
      status: 200,
      json: {
        text,
        usage: result.usage,
        costUsd: estimateCost(result.usage, env),
        model: result.model,
        upstreamMs: Date.now() - started,
      },
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, json: { error: err.code, message: err.message } };
    }
    if (err instanceof UpstreamError) {
      console.error(`OpenAI API error ${err.status}: ${err.body}`);
    } else {
      console.error("chat failed:", err?.message ?? err);
    }
    return { status: 502, json: { error: "upstream", message: "AIの呼び出しに失敗しました" } };
  }
}

export {
  LIMITS,
  HttpError,
  UpstreamError,
  validateRequest,
  buildInstructions,
  buildInput,
  extractText,
  cleanForSpeech,
  estimateCost,
  callOpenAI,
  createRateLimiter,
  accessAllowed,
  handleChat,
  partOfDay,
};
