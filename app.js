// 画面と処理をつなぐ。会話の流れそのものは lib/controller.js にある。

import { readSettings } from "./lib/config.js";
import { Lines } from "./lib/lines.js";
import { BrowserVoice } from "./lib/voice.js";
import { RelayChat } from "./lib/chat.js";
import { BrowserLocation, SimulatedLocation, ScreenWakeLock } from "./lib/device.js";
import { WalkController } from "./lib/controller.js";
import { formatDuration, formatInt, formatKm, formatSeconds } from "./lib/format.js";

const settings = readSettings(location.search);
const voice = new BrowserVoice();
const chat = new RelayChat({ url: settings.relayUrl, accessCode: settings.accessCode });
const wakeLock = new ScreenWakeLock();
let controller = null;
let renderQueued = false;

const $ = (id) => document.getElementById(id);

// ---- 初期表示 ----

for (const el of document.querySelectorAll("[data-character-name]")) {
  el.textContent = settings.characterName;
}
$("home-line").textContent = Lines.homeLine;
if (settings.demo) {
  $("home-badge").textContent = "試作版・デモ(歩かずに試せます)";
  $("home-badge").classList.add("is-demo");
}

function showScreen(name) {
  for (const s of ["home", "walk", "result"]) $(`screen-${s}`).hidden = s !== name;
  window.scrollTo(0, 0);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2200);
}

// ---- ホーム ----

$("start-button").addEventListener("click", () => $("safety-dialog").showModal());
$("safety-cancel").addEventListener("click", () => $("safety-dialog").close());
$("safety-start").addEventListener("click", () => {
  $("safety-dialog").close();
  startWalk();
});

/** ボタンを押した処理の中から、待たずに呼ぶ(iPhone で音を出すため)。 */
function startWalk() {
  const location = settings.demo ? new SimulatedLocation() : new BrowserLocation();
  controller = new WalkController({ voice, chat, location, wakeLock, config: settings });
  controller.autoListen = $("auto-listen-home").checked;
  controller.addEventListener("change", scheduleRender);
  controller.start(Lines.opening());
  $("text-form").hidden = !(settings.demo || !voice.SR);
  showScreen("walk");
  render();
}

// ---- 散歩中 ----

$("mic-button").addEventListener("click", () => controller?.onMicPressed());
$("auto-listen-walk").addEventListener("change", (e) => controller?.setAutoListen(e.target.checked));
$("text-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("text-input");
  controller?.sendText(input.value);
  input.value = "";
});

$("finish-button").addEventListener("click", () => $("finish-dialog").showModal());
$("finish-cancel").addEventListener("click", () => $("finish-dialog").close());
$("finish-ok").addEventListener("click", () => {
  $("finish-dialog").close();
  controller?.finish();
  showScreen("result");
  render();
});

// ポケットモード:画面を暗くしてタッチを止める。長押しで解除
$("pocket-button").addEventListener("click", () => ($("pocket").hidden = false));
{
  const pocket = $("pocket");
  let pressTimer = null;
  const cancel = () => clearTimeout(pressTimer);
  pocket.addEventListener("pointerdown", () => {
    cancel();
    pressTimer = setTimeout(() => (pocket.hidden = true), 800);
  });
  pocket.addEventListener("pointerup", cancel);
  pocket.addEventListener("pointercancel", cancel);
  pocket.addEventListener("contextmenu", (e) => e.preventDefault());
}

// 散歩中にうっかりページを閉じないように
window.addEventListener("beforeunload", (e) => {
  if (controller?.phase === "walking") e.preventDefault();
});

// ---- 結果 ----

$("copy-button").addEventListener("click", async () => {
  if (!controller) return;
  try {
    await navigator.clipboard.writeText(controller.resultText());
    toast("結果をコピーしました");
  } catch {
    toast("コピーできませんでした");
  }
});

$("home-button").addEventListener("click", () => {
  controller?.dispose();
  controller = null;
  showScreen("home");
});

// ---- 表示の更新 ----

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const c = controller;
  if (!c) return;
  if (c.phase === "walking") renderWalk(c);
  else if (c.phase === "finished") renderResult(c);
}

function lastMessage(c, fromCharacter) {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    if (c.messages[i].fromCharacter === fromCharacter) return c.messages[i];
  }
  return null;
}

const STATUS = {
  listening: () => "聞いてるよ。話し終わると自動で送ります",
  thinking: (name) => `${name}が考え中…`,
  speaking: (name) => `${name}が話してるよ`,
  idle: () => "マイクボタンで話しかけられます",
};

const MIC = {
  listening: { icon: "#i-stop", label: "話し終えた", disabled: false },
  speaking: { icon: "#i-mic", label: "さえぎって話す", disabled: false },
  thinking: { icon: "#i-dots", label: "考え中", disabled: true },
  idle: { icon: "#i-mic", label: "話しかける", disabled: false },
};

function renderWalk(c) {
  $("walk-steps").textContent = formatInt(c.steps);
  $("walk-time").textContent = formatDuration(c.elapsedMs);
  $("walk-distance").textContent = formatKm(c.distanceMeters);

  const notices = [c.gpsNotice, c.aiNotice, voice.sttProblem && `${voice.sttProblem}。字幕と読み上げは続きます。`]
    .filter(Boolean);
  const box = $("walk-notices");
  if (box.dataset.text !== notices.join("|")) {
    box.dataset.text = notices.join("|");
    box.replaceChildren(
      ...notices.map((text) => {
        const p = document.createElement("p");
        p.className = "notice";
        p.textContent = text;
        return p;
      }),
    );
  }

  const character = lastMessage(c, true);
  $("walk-character-bubble").hidden = !character;
  $("walk-character-text").textContent = character?.text ?? "";

  const userBubble = $("walk-user-bubble");
  const listening = c.voiceState === "listening";
  const user = lastMessage(c, false);
  userBubble.hidden = !listening && !user;
  userBubble.textContent = listening ? c.partialText || "…" : user?.text ?? "";
  userBubble.classList.toggle("is-partial", listening);
  const bubbles = $("walk-bubbles");
  bubbles.scrollTop = bubbles.scrollHeight;

  $("walk-status").textContent = STATUS[c.voiceState](settings.characterName);

  const mic = MIC[c.voiceState];
  const micButton = $("mic-button");
  micButton.disabled = mic.disabled;
  micButton.classList.toggle("is-listening", listening);
  micButton.setAttribute("aria-label", mic.label);
  $("mic-icon").setAttribute("href", mic.icon);
  $("mic-label").textContent = mic.label;
  $("auto-listen-walk").checked = c.autoListen;
}

function renderResult(c) {
  $("result-steps").textContent = formatInt(c.steps);
  $("result-time").textContent = formatDuration(c.elapsedMs);
  $("result-distance").textContent = formatKm(c.distanceMeters);
  $("result-comment").textContent = c.summaryLoading ? "今日の散歩をふりかえってるよ…" : c.summaryComment ?? "";

  const m = c.metrics;
  const rows = [
    ["こちらから話しかけた回数", `${c.userTurns}回`],
    ["AIの呼び出し", `${m.aiRequests}回${m.aiFailures ? `(うち失敗 ${m.aiFailures}回)` : ""}`],
    [
      "返事が届くまでの時間",
      c.averageLatencyMs === null
        ? "—"
        : `平均 ${formatSeconds(c.averageLatencyMs)}秒 / 最長 ${formatSeconds(c.maxLatencyMs)}秒`,
    ],
    ["トークン数(入力/出力)", `${formatInt(m.inputTokens)} / ${formatInt(m.outputTokens)}`],
    ["AIの料金(見積もり)", `$${m.costUsd.toFixed(4)}`],
    ["GPSで数えなかった測位", `${c.estimator.rejectedFixes}回`],
  ];
  $("result-metrics").replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }),
  );

  $("log-summary").textContent = `会話のログ(${c.messages.length}件)`;
  const log = $("result-log");
  if (log.childElementCount !== c.messages.length) {
    log.replaceChildren(
      ...c.messages.map((msg) => {
        const p = document.createElement("p");
        p.className = msg.fromCharacter ? "bubble" : "bubble bubble-user";
        if (msg.fromCharacter) {
          const name = document.createElement("span");
          name.className = "bubble-name";
          name.textContent = `${settings.characterName}${msg.prepared ? "(用意したセリフ)" : ""}`;
          p.append(name);
        }
        p.append(document.createTextNode(msg.text));
        return p;
      }),
    );
  }
}
