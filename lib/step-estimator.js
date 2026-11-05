// GPSの移動距離から歩数を推定する。
//
// ぶれ対策として、次の測位は数えない。
// - 誤差が maxAccuracyMeters より大きい測位
// - 前に数えた地点から minMoveMeters(または誤差の半分)未満しか動いていない測位
// - 歩く速さを超える移動(maxSpeedMps 超。位置の飛びや乗り物)

const EARTH_RADIUS = 6371000;

export function distanceBetween(lat1, lng1, lat2, lng2) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class StepEstimator {
  constructor({ strideMeters = 0.7, maxAccuracyMeters = 30, minMoveMeters = 10, maxSpeedMps = 3 } = {}) {
    this.strideMeters = strideMeters;
    this.maxAccuracyMeters = maxAccuracyMeters;
    this.minMoveMeters = minMoveMeters;
    this.maxSpeedMps = maxSpeedMps;
    this.reset();
  }

  reset() {
    this._anchor = null;
    this._distance = 0;
    this.lastAccuracy = null; // 直近の測位の誤差(メートル)
    this.rejectedFixes = 0; // 数えなかった測位の数
  }

  get distanceMeters() {
    return this._distance;
  }

  get steps() {
    return Math.floor(this._distance / this.strideMeters);
  }

  get hasFix() {
    return this.lastAccuracy !== null;
  }

  /**
   * 測位を1つ追加する。距離が増えたら true を返す。
   * @param {{lat:number, lng:number, accuracy:number, time:number}} fix time はミリ秒
   */
  add(fix) {
    this.lastAccuracy = fix.accuracy;
    if (fix.accuracy > this.maxAccuracyMeters) {
      this.rejectedFixes++;
      return false;
    }
    const anchor = this._anchor;
    if (!anchor) {
      this._anchor = fix;
      return false;
    }
    const moved = distanceBetween(anchor.lat, anchor.lng, fix.lat, fix.lng);
    const threshold = Math.max(this.minMoveMeters, fix.accuracy * 0.5);
    if (moved < threshold) return false;

    const seconds = (fix.time - anchor.time) / 1000;
    if (seconds <= 0 || moved / seconds > this.maxSpeedMps) {
      // 位置が飛んだか乗り物での移動とみなし、数えずに基準点だけ移す
      this._anchor = fix;
      this.rejectedFixes++;
      return false;
    }
    this._distance += moved;
    this._anchor = fix;
    return true;
  }
}
