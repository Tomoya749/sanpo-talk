// GitHub Pages 版の会話。中継サーバーの代わりに、この端末に保存した Google Gemini の APIキーで直接 Gemini を呼ぶ。
// AIへの指示の組み立てや返事の整え方は、中継サーバーと同じ core.js をそのまま使う。
// core.js は OpenAI(Responses API)の形で通信するので、fetch の部分で Gemini の形に変換している。
// 自分で遊ぶための形なので、APIキーはこの端末のブラウザの中(localStorage)だけに保存し、ほかには送らない。

import { handleChat } from "./core.js";
import { CHARACTER } from "./character.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const STORAGE_KEY = "sanpo-talk.gemini-api-key";
// 最新の Flash を指す別名。名前が変わったときは、ここだけ直す
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function loadKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeKey(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// OpenAI 形式の入力(user / assistant / developer)を Gemini の contents にする。
// Gemini は先頭が user であることを求めるので、同じ役の連続は1つにまとめ、先頭が model なら user を足す
export function toGeminiContents(input) {
  const contents = [];
  for (const item of input) {
    const role = item.role === "assistant" ? "model" : "user";
    const text = String(item.content ?? "");
    if (!text) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  if (contents.length && contents[0].role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "(散歩が始まった)" }] });
  }
  return contents;
}

function geminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
}

// core.js が呼ぶ「OpenAI への fetch」を、Gemini への呼び出しに差し替える
function makeGeminiFetch(apiKey, onStatus) {
  return async (_url, init) => {
    const req = JSON.parse(init.body);
    const body = {
      systemInstruction: { parts: [{ text: req.instructions }] },
      contents: toGeminiContents(req.input),
      generationConfig: { maxOutputTokens: req.max_output_tokens },
    };
    const send = (payload) =>
      fetch(GEMINI_URL(GEMINI_MODEL), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
        signal: init.signal,
      });

    // 会話の待ち時間を短くするため、考える工程は切る。対応していないモデルなら外してやり直す
    let res = await send({ ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingBudget: 0 } } });
    if (res.status === 400) {
      const errText = await res.clone().text();
      if (/thinking/i.test(errText)) res = await send(body);
    }
    onStatus(res.status);
    if (!res.ok) return res;

    const json = await res.json();
    return new Response(
      JSON.stringify({
        output_text: geminiText(json),
        usage: {
          input_tokens: json?.usageMetadata?.promptTokenCount ?? 0,
          output_tokens: json?.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model: json?.modelVersion ?? GEMINI_MODEL,
        status: "completed",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// app.js から見た形は、中継サーバーを使う版(RelayChat)と同じにしている
export class RelayChat {
  constructor() {
    this.lastStatus = null;
    this.lastError = null;
    this.upstreamStatus = null;
  }

  async send({ mode, history, stats }) {
    const started = Date.now();
    const key = loadKey();
    if (!key) {
      this.lastStatus = "no_key";
      return null;
    }
    this.upstreamStatus = null;
    const result = await handleChat({
      method: "POST",
      body: { mode, history, stats },
      headers: {},
      ip: "this-device",
      // Gemini の無料枠なので料金は0。OpenAI 用のモデル名・推論設定は使わない
      env: { ...DEFAULT_SETTINGS, OPENAI_API_KEY: key, ACCESS_CODE: "none", PRICE_INPUT_PER_M: "0", PRICE_OUTPUT_PER_M: "0" },
      character: CHARACTER,
      limiter: null,
      fetchImpl: makeGeminiFetch(key, (status) => {
        this.upstreamStatus = status;
      }),
    });
    this.lastStatus = result.status;
    if (result.status !== 200) {
      this.lastError = result.json?.message ?? null;
      return null;
    }
    this.lastError = null;
    const data = result.json;
    return {
      text: data.text,
      inputTokens: Number(data.usage?.inputTokens ?? 0),
      outputTokens: Number(data.usage?.outputTokens ?? 0),
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  describeFailure() {
    if (this.lastStatus === "no_key") {
      return "AIのキーが入っていないため、用意したセリフで続けます。ホーム画面でGeminiのAPIキーを入れてください。";
    }
    if (this.lastStatus === 502) {
      if (this.upstreamStatus === 429) return "Geminiの無料枠の上限に達しました。少し待つと、また話せます。今は用意したセリフで続けます。";
      if (this.upstreamStatus === 400 || this.upstreamStatus === 401 || this.upstreamStatus === 403) {
        return "AIにつながりません。GeminiのAPIキーが正しいかを確かめてください。";
      }
      return "AIにつながりません。用意したセリフで続けます。";
    }
    return null;
  }
}

// ---- ホーム画面の「AIのキー」欄 ----

function setupKeyCard() {
  const input = document.getElementById("ai-key-input");
  const save = document.getElementById("ai-key-save");
  const clear = document.getElementById("ai-key-clear");
  const status = document.getElementById("ai-key-status");
  if (!input || !save || !clear || !status) return;

  const render = (message) => {
    const key = loadKey();
    status.textContent = message ?? (key ? `保存済み(末尾 ${key.slice(-4)})` : "まだ入っていません");
    clear.hidden = !key;
  };

  save.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return render("キーを貼り付けてから「保存」を押してください");
    if (!/^AIza[A-Za-z0-9_-]{30,}$/.test(value)) return render("AIza で始まるGeminiのAPIキーを、そのまま貼り付けてください");
    if (!storeKey(value)) return render("このブラウザでは保存できません。プライベートモードを外してください");
    input.value = "";
    render();
  });
  clear.addEventListener("click", () => {
    storeKey("");
    render("キーを消しました");
  });
  render();
}

setupKeyCard();
