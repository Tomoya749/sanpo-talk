// GitHub Pages 版の会話。中継サーバーの代わりに、この端末に保存した OpenAI の APIキーで直接 OpenAI を呼ぶ。
// AIへの指示の組み立てや返事の整え方は、中継サーバーと同じ core.js をそのまま使う。
// 自分で遊ぶための形なので、APIキーはこの端末のブラウザの中(localStorage)だけに保存し、ほかには送らない。

import { handleChat } from "./core.js";
import { CHARACTER } from "./character.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const STORAGE_KEY = "sanpo-talk.openai-api-key";

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

// app.js から見た形は、中継サーバーを使う版(RelayChat)と同じにしている
export class RelayChat {
  constructor() {
    this.lastStatus = null;
    this.lastError = null;
  }

  async send({ mode, history, stats }) {
    const started = Date.now();
    const key = loadKey();
    if (!key) {
      this.lastStatus = "no_key";
      return null;
    }
    const result = await handleChat({
      method: "POST",
      body: { mode, history, stats },
      headers: {},
      ip: "this-device",
      env: { ...DEFAULT_SETTINGS, OPENAI_API_KEY: key, ACCESS_CODE: "none" },
      character: CHARACTER,
      limiter: null,
      fetchImpl: (...args) => fetch(...args),
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
      costUsd: Number(data.costUsd ?? 0),
      latencyMs: Date.now() - started,
    };
  }

  describeFailure() {
    if (this.lastStatus === "no_key") {
      return "AIのキーが入っていないため、用意したセリフで続けます。ホーム画面でOpenAIのAPIキーを入れてください。";
    }
    if (this.lastStatus === 502) {
      return "AIにつながりません。APIキーが正しいか、OpenAIにクレジットが入っているかを確かめてください。";
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
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(value)) return render("sk- で始まるOpenAIのAPIキーを、そのまま貼り付けてください");
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
