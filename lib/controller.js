// 散歩1回分の状態と、会話の流れをまとめて管理する。
// 画面(app.js)とは切り離してあるので、Node のテストで流れを確かめられる。

import { StepEstimator } from "./step-estimator.js";
import { Lines } from "./lines.js";
import { formatDuration, formatInt, formatKm, formatSeconds } from "./format.js";

const pad = (n) => String(n).padStart(2, "0");

export class WalkController extends EventTarget {
  /**
   * @param {object} deps
   * @param {{speak, stopSpeaking, listenOnce, stopListening, cancelListening, canListen, sttProblem}} deps.voice
   * @param {{send, lastStatus}} deps.chat
   * @param {{start, stop}} deps.location
   * @param {{enable, disable}} [deps.wakeLock]
   */
  constructor({ voice, chat, location, wakeLock = null, config, now = () => Date.now() }) {
    super();
    this.voice = voice;
    this.chat = chat;
    this.location = location;
    this.wakeLock = wakeLock;
    this.config = config;
    this.now = now;
    this.estimator = new StepEstimator({ strideMeters: config.strideMeters });

    this.phase = "ready"; // ready / walking / finished
    this.voiceState = "idle"; // idle / listening / thinking / speaking
    this.autoListen = true; // 返事のあとに自動で聞き取るか
    this.messages = []; // {fromCharacter, text, prepared, at}
    this.partialText = ""; // 聞き取り中の言葉(確定前)
    this.gpsNotice = null;
    this.aiNotice = null;
    this.startedAt = null;
    this.endedAt = null;
    this.summaryComment = null;
    this.summaryLoading = false;
    this.metrics = { aiRequests: 0, aiFailures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latenciesMs: [] };

    this._loopRunning = false;
    this._listenRequested = false;
    this._queuedMode = null;
    this._pendingMilestone = null;
    this._pendingUserText = null;
    this._nextTalkAt = config.talkEverySteps;
    this._openingSpeech = null;
    this._ticker = null;
    this._disposed = false;
  }

  get steps() {
    return this.estimator.steps;
  }

  get distanceMeters() {
    return this.estimator.distanceMeters;
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt ?? this.now()) - this.startedAt;
  }

  get userTurns() {
    return this.messages.filter((m) => !m.fromCharacter).length;
  }

  get averageLatencyMs() {
    const l = this.metrics.latenciesMs;
    return l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null;
  }

  get maxLatencyMs() {
    const l = this.metrics.latenciesMs;
    return l.length ? Math.max(...l) : null;
  }

  /**
   * 散歩を始める。必ずボタンを押した処理の中で、ほかの await より前に呼ぶこと。
   * 最初のセリフをすぐ読み上げることで、iPhone でも音が出るようにしている。
   */
  start(openingLine) {
    if (this.phase !== "ready") return;
    this.phase = "walking";
    this.startedAt = this.now();
    this.estimator.reset();
    this._nextTalkAt = this.config.talkEverySteps;

    this._openingSpeech = this._speakLine(openingLine, true);
    this._queuedMode = "greeting";
    this._runLoop();

    this.location.start(
      (fix) => this._onFix(fix),
      (reason) => this._onLocationError(reason),
    );
    this._ticker = setInterval(() => this._notify(), 1000);
    this.wakeLock?.enable();
  }

  /** マイクボタンが押されたとき。 */
  onMicPressed() {
    if (this.phase !== "walking") return;
    switch (this.voiceState) {
      case "listening":
        this.voice.stopListening();
        break;
      case "speaking":
        // 話をさえぎって、こちらから話す
        this._listenRequested = true;
        this.voice.stopSpeaking();
        break;
      case "thinking":
        break;
      default:
        this._listenRequested = true;
        this._runLoop();
    }
  }

  /** 文字で話しかけたとき(デモや、音声の聞き取りが使えないブラウザ用)。 */
  sendText(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || this.phase !== "walking") return;
    this._pendingUserText = trimmed;
    if (this.voiceState === "listening") this.voice.cancelListening();
    else if (this.voiceState === "speaking") this.voice.stopSpeaking();
    this._runLoop();
  }

  setAutoListen(value) {
    this.autoListen = Boolean(value);
    this._notify();
  }

  /** 散歩を終える。結果画面用に、キャラクターのひとことを取りにいく。 */
  async finish() {
    if (this.phase !== "walking") return;
    this.phase = "finished";
    this.endedAt = this.now();
    clearInterval(this._ticker);
    this._ticker = null;
    this.location.stop();
    this.voice.stopSpeaking();
    this.voice.cancelListening();
    this.wakeLock?.disable();
    this.voiceState = "idle";
    this.partialText = "";
    this.summaryLoading = true;
    this._notify();

    const reply = await this._send("summary");
    this.summaryComment = reply?.text ?? Lines.summary(this.steps);
    this.summaryLoading = false;
    this._addMessage(true, this.summaryComment, !reply);
    if (!this._disposed) this.voice.speak(this.summaryComment);
  }

  dispose() {
    this._disposed = true;
    clearInterval(this._ticker);
    this._ticker = null;
    this.location.stop();
    this.voice.stopSpeaking();
    this.voice.cancelListening();
    this.wakeLock?.disable();
  }

  /** 結果をテキストにする(テスターが感想と一緒に送れるように)。 */
  resultText() {
    const m = this.metrics;
    const lines = [
      `【さんぽトーク 試作版の結果】${new Date(this.startedAt ?? this.now()).toLocaleString("ja-JP")}`,
      `歩数(推定): ${formatInt(this.steps)}歩 / 距離: ${formatKm(this.distanceMeters)}km / 時間: ${formatDuration(this.elapsedMs)}`,
      `話しかけた回数: ${this.userTurns}回`,
      `AIの呼び出し: ${m.aiRequests}回(失敗 ${m.aiFailures}回)`,
      this.averageLatencyMs === null
        ? "返事までの時間: —"
        : `返事までの時間: 平均${formatSeconds(this.averageLatencyMs)}秒 / 最長${formatSeconds(this.maxLatencyMs)}秒`,
      `AIの料金(見積もり): $${m.costUsd.toFixed(4)}`,
      `GPSで数えなかった測位: ${this.estimator.rejectedFixes}回`,
      "",
      "--- 会話 ---",
      ...this.messages.map(
        (msg) => `${msg.fromCharacter ? this.config.characterName : "わたし"}: ${msg.text}`,
      ),
    ];
    return lines.join("\n");
  }

  // ---- 会話の流れ ----

  /** 会話を1本の流れで順番に進める(同時に2つ話さないように)。 */
  async _runLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    try {
      if (this._openingSpeech) {
        await this._openingSpeech;
        this._openingSpeech = null;
      }
      while (this.phase === "walking" && !this._disposed) {
        if (this._queuedMode) {
          const mode = this._queuedMode;
          this._queuedMode = null;
          await this._characterTurn(mode);
          this._afterCharacter();
        } else if (this._pendingUserText) {
          const text = this._pendingUserText;
          this._pendingUserText = null;
          this._addMessage(false, text);
          await this._characterTurn("chat");
          this._afterCharacter();
        } else if (this._pendingMilestone !== null) {
          const milestone = this._pendingMilestone;
          this._pendingMilestone = null;
          await this._characterTurn("milestone", { fallback: Lines.milestone(milestone), milestone });
          this._afterCharacter();
        } else if (this._listenRequested) {
          this._listenRequested = false;
          const heard = await this._listen();
          if (this.phase !== "walking") break;
          if (heard) {
            this._addMessage(false, heard);
            await this._characterTurn("chat");
            this._afterCharacter();
          }
        } else {
          break;
        }
      }
    } finally {
      this._loopRunning = false;
      if (this.phase === "walking") {
        this.voiceState = "idle";
        this._notify();
      }
    }
  }

  _afterCharacter() {
    this._listenRequested = this._listenRequested || (this.autoListen && this.voice.canListen);
  }

  async _characterTurn(mode, { fallback, milestone } = {}) {
    this.voiceState = "thinking";
    this._notify();
    const reply = await this._send(mode, milestone);
    if (this.phase !== "walking") return;
    await this._speakLine(reply?.text ?? fallback ?? Lines.networkError, !reply);
  }

  async _speakLine(text, prepared = false) {
    this._addMessage(true, text, prepared);
    this.voiceState = "speaking";
    this._notify();
    await this.voice.speak(text);
    if (this.phase === "walking") {
      this.voiceState = "idle";
      this._notify();
    }
  }

  async _listen() {
    this.voiceState = "listening";
    this.partialText = "";
    this._notify();
    const heard = await this.voice.listenOnce({
      onPartial: (text) => {
        this.partialText = text;
        this._notify();
      },
    });
    this.partialText = "";
    if (this.phase === "walking") {
      this.voiceState = "idle";
      this._notify();
    }
    return heard;
  }

  async _send(mode, milestone = null) {
    const history = this.messages.slice(-this.config.historyLimit).map((m) => ({
      role: m.fromCharacter ? "assistant" : "user",
      text: m.text,
    }));
    const d = new Date(this.now());
    const stats = {
      steps: this.steps,
      distanceMeters: Math.round(this.distanceMeters),
      minutes: Math.floor(this.elapsedMs / 60000),
      localTime: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
    if (milestone !== null) stats.milestone = milestone;

    this.metrics.aiRequests++;
    const reply = await this.chat.send({ mode, history, stats });
    if (reply) {
      this.metrics.inputTokens += reply.inputTokens;
      this.metrics.outputTokens += reply.outputTokens;
      this.metrics.costUsd += reply.costUsd;
      this.metrics.latenciesMs.push(reply.latencyMs);
      this.aiNotice = null;
    } else {
      this.metrics.aiFailures++;
      this.aiNotice =
        this.chat.describeFailure?.() ??
        (this.chat.lastStatus === 401
          ? "合言葉が正しくないため、AIと話せません。配られたURLをそのまま開いてください。"
          : "AIにつながりません。用意したセリフで続けます。");
    }
    this._notify();
    return reply;
  }

  _addMessage(fromCharacter, text, prepared = false) {
    this.messages.push({ fromCharacter, text, prepared, at: this.now() });
    this._notify();
  }

  // ---- 位置情報と歩数 ----

  _onFix(fix) {
    if (this.phase !== "walking") return;
    const counted = this.estimator.add(fix);
    this.gpsNotice =
      fix.accuracy > this.estimator.maxAccuracyMeters
        ? `GPSの精度が低いため、歩数が増えにくくなっています(誤差 約${Math.round(fix.accuracy)}m)`
        : null;
    if (counted) this._checkMilestone();
    this._notify();
  }

  _onLocationError(reason) {
    this.gpsNotice =
      reason === "denied"
        ? "位置情報が許可されていないため、歩数を数えられません。ブラウザの設定で許可してください。"
        : reason === "unsupported"
          ? "このブラウザでは位置情報を使えません。"
          : "位置情報を取得できません。空が開けた場所で試してください。";
    this._notify();
  }

  _checkMilestone() {
    if (this.steps < this._nextTalkAt) return;
    let reached = this._nextTalkAt;
    while (this._nextTalkAt <= this.steps) {
      reached = this._nextTalkAt;
      this._nextTalkAt += this.config.talkEverySteps;
    }
    this._pendingMilestone = reached;
    // まだ何も話していない聞き取り中なら、取り消してキャラクターから話しかける
    if (this.voiceState === "listening" && !this.partialText) this.voice.cancelListening();
    this._runLoop();
  }

  _notify() {
    if (!this._disposed) this.dispatchEvent(new Event("change"));
  }
}
