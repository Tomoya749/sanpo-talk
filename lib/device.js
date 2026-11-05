// 位置情報と、画面を消さないための仕組み。

/** ブラウザの位置情報(GPS)。 */
export class BrowserLocation {
  start(onFix, onError) {
    if (!globalThis.navigator?.geolocation) {
      onError("unsupported");
      return;
    }
    this._watchId = navigator.geolocation.watchPosition(
      (p) =>
        onFix({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          time: p.timestamp,
        }),
      (err) => onError(err.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this._watchId != null) navigator.geolocation.clearWatch(this._watchId);
    this._watchId = null;
  }
}

/**
 * 歩かずに試すための、歩く動きのまね(?demo=1)。
 * 時間を timeScale 倍に進めるので、実際の5倍の速さで歩数が増える。
 */
export class SimulatedLocation {
  constructor({ speedMps = 1.3, timeScale = 5, intervalMs = 1000, origin = { lat: 36.064, lng: 136.219 } } = {}) {
    Object.assign(this, { speedMps, timeScale, intervalMs, origin });
  }

  start(onFix) {
    let time = Date.now();
    let north = 0;
    const emit = () =>
      onFix({ lat: this.origin.lat + north / 111320, lng: this.origin.lng, accuracy: 5, time });
    emit();
    this._timer = setInterval(() => {
      time += this.intervalMs * this.timeScale;
      north += (this.speedMps * this.intervalMs * this.timeScale) / 1000;
      emit();
    }, this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

/** 散歩中に画面が自動で消えないようにする(対応ブラウザのみ)。 */
export class ScreenWakeLock {
  constructor() {
    this._wanted = false;
    this._sentinel = null;
    this._onVisible = () => {
      if (document.visibilityState === "visible" && this._wanted) this._acquire();
    };
  }

  get supported() {
    return Boolean(globalThis.navigator?.wakeLock);
  }

  async enable() {
    this._wanted = true;
    document.addEventListener("visibilitychange", this._onVisible);
    await this._acquire();
  }

  async disable() {
    this._wanted = false;
    document.removeEventListener("visibilitychange", this._onVisible);
    try {
      await this._sentinel?.release();
    } catch {
      // 何もしない
    }
    this._sentinel = null;
  }

  async _acquire() {
    if (!this.supported || this._sentinel) return;
    try {
      this._sentinel = await navigator.wakeLock.request("screen");
      this._sentinel.addEventListener("release", () => {
        this._sentinel = null;
      });
    } catch {
      // 省電力モードなどで断られることがある
    }
  }
}
