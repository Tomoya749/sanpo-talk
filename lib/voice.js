// 読み上げ(ブラウザの音声合成)と聞き取り(ブラウザの音声認識)。どちらも無料。

export class BrowserVoice {
  constructor({ lang = "ja-JP", rate = 1.0, pitch = 1.15 } = {}) {
    this.lang = lang;
    this.rate = rate;
    this.pitch = pitch;
    this.synth = globalThis.speechSynthesis ?? null;
    this.SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
    this.sttProblem = this.SR ? null : "このブラウザでは音声の聞き取りが使えません";
    this.sttBlocked = !this.SR; // マイクが拒否されたなど、聞き取りを続けても無駄な状態
    this._voice = null;
    this._finishSpeaking = null;
    this._rec = null;
    this._settleListening = null;
    this._discard = false;
    if (this.synth) {
      this._pickVoice();
      this.synth.addEventListener?.("voiceschanged", () => this._pickVoice());
    }
  }

  get canListen() {
    return Boolean(this.SR) && !this.sttBlocked;
  }

  _pickVoice() {
    const voices = this.synth?.getVoices?.() ?? [];
    const japanese = voices.filter((v) => (v.lang ?? "").replace("_", "-").toLowerCase().startsWith("ja"));
    this._voice =
      japanese.find((v) => /Kyoko|O-?ren|Nanami|Female|女性/i.test(v.name)) ?? japanese[0] ?? null;
  }

  /**
   * text を読み上げ、読み終わったら解決する Promise を返す。
   * iPhone の Safari はボタンを押した直後でないと音を出さないので、
   * ボタンの処理の中で、ほかの await より先に呼ぶこと(この関数は呼ばれた瞬間に読み上げを始める)。
   */
  speak(text) {
    this._finishSpeaking?.();
    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this._finishSpeaking === done) this._finishSpeaking = null;
        resolve();
      };
      this._finishSpeaking = done;
      if (!this.synth) {
        // 読み上げが使えないときは、字幕を読む時間だけ待つ
        timer = setTimeout(done, Math.min(4000, 800 + text.length * 80));
        return;
      }
      // 終わりの通知が来ないブラウザがあるため、文字数から長さを見積もって打ち切る
      timer = setTimeout(done, 3000 + text.length * 250);
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = this.lang;
        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        if (this._voice) utterance.voice = this._voice;
        utterance.onend = done;
        utterance.onerror = done;
        this._utterance = utterance; // 途中で消えないように参照を持っておく
        this.synth.speak(utterance);
      } catch {
        done();
      }
    });
  }

  stopSpeaking() {
    try {
      this.synth?.cancel();
    } catch {
      // 何もしない
    }
    this._finishSpeaking?.();
  }

  /**
   * 1回分の発言を聞き取って返す。何も聞き取れなければ空文字。
   * 聞き取り中の文字は onPartial に随時渡す。
   */
  listenOnce({ onPartial, maxMs = 20000 } = {}) {
    if (!this.canListen) return Promise.resolve("");
    return new Promise((resolve) => {
      let finalText = "";
      let interim = "";
      let settled = false;
      const rec = new this.SR();
      const settle = (text) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (this._rec === rec) {
          this._rec = null;
          this._settleListening = null;
        }
        resolve(String(text ?? "").trim());
      };
      this._rec = rec;
      this._settleListening = settle;
      this._discard = false;

      rec.lang = this.lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let f = "";
        let i = "";
        for (let k = 0; k < event.results.length; k++) {
          const result = event.results[k];
          if (result.isFinal) f += result[0].transcript;
          else i += result[0].transcript;
        }
        finalText = f;
        interim = i;
        onPartial?.(f + i);
      };
      rec.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.sttProblem = "マイクの使用が許可されていません";
          this.sttBlocked = true;
        } else if (event.error === "audio-capture") {
          this.sttProblem = "マイクが見つかりません";
          this.sttBlocked = true;
        }
      };
      rec.onend = () => settle(this._discard ? "" : finalText || interim);

      // 終わりの通知が来ない場合に備えた保険
      const guard = setTimeout(() => {
        try {
          rec.stop();
        } catch {
          // 何もしない
        }
        setTimeout(() => settle(finalText || interim), 1500);
      }, maxMs);

      try {
        rec.start();
      } catch {
        this.sttProblem = "聞き取りを始められませんでした。マイクボタンを押して話しかけてください";
        settle("");
      }
    });
  }

  /** 聞き取りを終えて、そこまでの言葉を確定させる。 */
  stopListening() {
    try {
      this._rec?.stop();
    } catch {
      // 何もしない
    }
  }

  /** 聞き取りを取り消す(聞き取った言葉は捨てる)。 */
  cancelListening() {
    this._discard = true;
    const settle = this._settleListening;
    try {
      this._rec?.abort();
    } catch {
      // 何もしない
    }
    if (settle) setTimeout(() => settle(""), 400);
  }
}
