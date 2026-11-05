// 用意しておくセリフ。AIを待たずにすぐ話したい場面と、
// 通信に失敗したときの代わりに使う。

const OPENINGS = ["じゃあ、行こっか！", "よーし、出発しよ！", "お待たせ！いっしょに歩こ！"];

export const Lines = Object.freeze({
  homeLine: "今日もいっしょに歩こ？",
  // 散歩開始ボタンを押した直後に、すぐ読み上げるセリフ
  opening: (random = Math.random) => OPENINGS[Math.floor(random() * OPENINGS.length)],
  networkError: "あれ、ちょっと電波が悪いみたい。もう一回話しかけてくれる？",
  milestone: (steps) => `${steps.toLocaleString("ja-JP")}歩、到達！いい調子だね！`,
  summary: (steps) => `おつかれさま！今日は${steps.toLocaleString("ja-JP")}歩も歩いたね。また明日も行こ！`,
});
