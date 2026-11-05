// アプリの設定。ここを書き換えて再公開すると反映される。
export const CONFIG = Object.freeze({
  // 会話の中継サーバー。Firebase Hosting で公開するなら "/api/chat" のままでよい
  relayUrl: "/api/chat",
  // 歩幅(メートル)。GPSの移動距離をこの値で割って歩数を推定する
  strideMeters: 0.7,
  // 何歩ごとにキャラクターから話しかけるか
  talkEverySteps: 1000,
  // AIに渡す直近の発言数(サーバー側の上限も12)
  historyLimit: 12,
  // キャラクターの表示名。functions/character.js と合わせる
  characterName: "ハル",
  characterImage: "assets/character.png",
});

/**
 * URLの末尾で一部の設定を変えられるようにする(試すとき用)。
 *   ?code=合言葉   中継サーバーに送る合言葉
 *   ?demo=1        歩かずに試すデモ(歩く動きをまねて、文字でも話しかけられる)
 *   ?every=200     話しかける歩数の間隔
 *   ?stride=0.65   歩幅
 */
export function readSettings(search = "") {
  const params = new URLSearchParams(search);
  const num = (key, fallback, min, max) => {
    const value = Number(params.get(key));
    return params.has(key) && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    ...CONFIG,
    strideMeters: num("stride", CONFIG.strideMeters, 0.3, 1.5),
    talkEverySteps: Math.round(num("every", CONFIG.talkEverySteps, 20, 20000)),
    accessCode: params.get("code") || null,
    demo: params.get("demo") === "1",
  };
}
