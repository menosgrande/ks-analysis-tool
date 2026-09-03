/* ============================================================
   pose-math.js — Pose座標・角度・時系列に関する純粋関数群

   M-1（app.js責務分離）の最初の切り出し単位。
   ここに置く関数の選定基準：
     - DOM / Canvas / Three.js に一切触れない
     - state を「読む」ことはあっても、書き換えない
     - 入力が同じなら出力も同じ（テスト可能）

   classic script として index.html から app.js より前に読み込む
   （ES Modules化はしない。file:// 直接オープンでの動作を維持するため。
   README.md の file:// 互換性に関する説明を参照）。

   state はここでは定義しない。isReliablePoint() は実行時に
   グローバルスコープの state.visibilityThreshold を参照するが、
   これは関数「呼び出し時」に評価されるため、app.js と pose-math.js の
   読み込み順序には依存しない（state の宣言は app.js 内にある）。

   将来のReliability/quality情報のデータモデル拡張は、まずこのファイルに
   置く関数群の入出力を「品質メタデータ付き」に拡張することから始める想定。
   ただし今回のM-1初回コミットでは、既存の挙動を一切変えていない
   （関数の中身は app.js からの単純な移動のみ）。
============================================================ */

/* ============================================================
10-b. calcAngle3D (LOCAL ONLY)
ローカル座標の3点から角度を求める
============================================================ */
function calcAngle3D(a, b, c) {
    if (!a || !b || !c) return null;

    // worldLocal 座標は visibility を持たない場合があるため、
    // 呼び出し側の isReliablePoint でフィルタ済みとして visibility チェックは省略
    const ab = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    const cb = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };

    const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
    const magAB = Math.sqrt(ab.x**2 + ab.y**2 + ab.z**2);
    const magCB = Math.sqrt(cb.x**2 + cb.y**2 + cb.z**2);

    if (magAB === 0 || magCB === 0) return null;

    // ★ 数値誤差ガード（必須）
    let cos = dot / (magAB * magCB);
    cos = Math.max(-1, Math.min(1, cos));

    return Math.acos(cos) * (180 / Math.PI);
}

function isReliablePoint(p, prev) {
    if (!p) return false;

    const vis = (p.visibility !== undefined && p.visibility !== null)
        ? p.visibility : 1;

    if (vis < state.visibilityThreshold) return false;

    // 画面端ノイズ除去（マージン0.01 = 1%に緩和）
    const margin = 0.01;
    if (p.x < margin || p.x > 1 - margin ||
        p.y < margin || p.y > 1 - margin) return false;

    // 前フレームとの速度チェック（prev が null = 最初のフレームはスキップ）
    if (prev && prev.x !== undefined && prev.y !== undefined) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        if (dx * dx + dy * dy > 0.25 * 0.25) return false;
    }

    return true;
}

/* --- 角速度・角加速度: 隣接フレーム差分による有限差分近似 ---
   AB ジャンプ・シーク直後などで時刻が不連続に飛ぶ場合、
   dt が異常値になるためその区間は null にして線を切る。 */
const _MAX_DT_GAP = 0.5; // 秒。これを超える dt は不連続とみなしスキップ

function _diffSeries(values, times) {
    const n = values.length;
    const result = new Array(n).fill(null);
    for (let k = 1; k < n; k++) {
        const v0 = values[k - 1], v1 = values[k];
        if (v0 == null || v1 == null) continue;
        const dt = times[k] - times[k - 1];
        if (dt <= 0 || dt > _MAX_DT_GAP) continue;
        result[k] = (v1 - v0) / dt;
    }
    return result;
}

// Node.js (テスト実行用)・ブラウザ(classic script)の両方で動くようにする。
// ブラウザでは module が未定義なので何もしない。
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { calcAngle3D, isReliablePoint, _diffSeries, _MAX_DT_GAP };
}
