/* ============================================================
   history.js — state.history の不変条件を守る純粋関数群

   M-1（app.js責務分離）の2番目の切り出し単位。

   ★ pose-math.js との違い：isReliablePoint は state を暗黙参照する形の
   まま残したが（呼び出し箇所9箇所、変更コストが高いため）、こちらは
   呼び出し箇所が計3箇所と少なかったため、この機会に「配列を引数で
   受け取る」形へシグネチャを変更した。history配列(state.history)を
   第一引数で明示的に渡す。state読み書きは呼び出し側(app.js)の責任とし、
   ここでは配列そのものへの操作のみを行う。

   不変条件（C-1で確定・絶対に壊さない）：
     - history は t 昇順
     - 同一時刻(誤差1ms未満)の重複を作らない
     - 逆行シーク・A/Bジャンプによって順序が壊れない

   classic script として index.html から app.js より前に読み込む
   （ES Modules化はしない。file:// 直接オープンでの動作を維持するため）。
============================================================ */

/* ------------------------------------------------------------
★ Bug-C1 fix: hist をソート済み(t昇順)配列として維持する挿入関数
------------------------------------------------------------
従来は hist.push(frame) で末尾に単純追加していたため、
以下のいずれかが発生すると t が非単調になり、_histBinarySearch()
（t昇順を前提とする二分探索）の結果が不正になる可能性があった：
  1. A/Bループでのジャンプ（B→A、時間逆行）
  2. シークバーのドラッグ・クリックによる任意方向のシーク
     （seekAndDetect() は abJumping を経由せず onPoseResults を直接呼ぶ）
このため「順再生時は高速パス（末尾追加）」「逆行・任意シーク時は
二分探索で挿入位置を求めて splice、同一時刻(1ms未満)なら上書き」
という方式に変更し、常にソート済み・重複なしを保証する。

hist を直接変更する（mutates in place）。戻り値はない。
------------------------------------------------------------ */
function _insertHistoryFrame(hist, frame) {
    const n = hist.length;

    // 順再生（最も多いケース）: 末尾に追加するだけの高速パス
    if (n === 0 || frame.t > hist[n - 1].t) {
        hist.push(frame);
        return;
    }

    // 逆行・シーク: 挿入位置を二分探索
    let lo = 0, hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (hist[mid].t < frame.t) lo = mid + 1; else hi = mid;
    }

    // 同一時刻（誤差1ms未満）のフレームが既にあれば上書き（再訪問時の重複防止）
    if (hist[lo] && Math.abs(hist[lo].t - frame.t) < 0.001) {
        hist[lo] = frame;
    } else if (lo > 0 && Math.abs(hist[lo - 1].t - frame.t) < 0.001) {
        hist[lo - 1] = frame;
    } else {
        hist.splice(lo, 0, frame);
    }
}

/* hist(t昇順が前提)の中で、t以下の最後の要素の「次」のインデックスを返す
   二分探索。空配列・undefined要素にも安全。 */
function _histBinarySearch(hist, t) {
    if (!hist.length) return 0; // ★ 修正2: 空配列クラッシュ防止
    let lo = 0, hi = hist.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // ★ 修正2: 配列要素が undefined の場合（バックグラウンド競合）も安全に処理
        if (hist[mid]?.t <= t) lo = mid + 1; else hi = mid;
    }
    return Math.min(lo, hist.length); // ★ 修正2: 上限を hist.length に固定
}

// Node.js (テスト実行用)・ブラウザ(classic script)の両方で動くようにする。
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _insertHistoryFrame, _histBinarySearch };
}
