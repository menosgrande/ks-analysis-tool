/* ============================================================
   history.test.js — history.js の回帰テスト

   実行方法: node --test history.test.js

   C-1（historyの非単調化バグ）で確定した不変条件を、そのままテストとして
   固定する。「テストのために設計する」のではなく、既に実装済み・
   既に一度バグとして踏んだ挙動を後追いでテスト化する。
============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { _insertHistoryFrame, _histBinarySearch } = require('./history.js');

test('_insertHistoryFrame: 順再生（末尾追加の高速パス）', () => {
    const hist = [];
    _insertHistoryFrame(hist, { t: 0.0 });
    _insertHistoryFrame(hist, { t: 0.1 });
    _insertHistoryFrame(hist, { t: 0.2 });
    assert.deepEqual(hist.map(f => f.t), [0.0, 0.1, 0.2]);
});

test('_insertHistoryFrame: 逆行挿入後もt昇順を維持する (C-1不変条件)', () => {
    const hist = [];
    _insertHistoryFrame(hist, { t: 0.0 });
    _insertHistoryFrame(hist, { t: 0.2 });
    _insertHistoryFrame(hist, { t: 0.1 }); // A/Bジャンプ・逆シーク相当
    assert.deepEqual(hist.map(f => f.t), [0.0, 0.1, 0.2]);
});

test('_insertHistoryFrame: 逆行/再訪問時、同一時刻(1ms未満)は重複を作らず上書きする (C-1不変条件)', () => {
    // dedupチェックは「逆行・再訪問」パス(frame.t <= 最後の要素のt)でのみ働く。
    // 通常の順再生パス(frame.t > 最後の要素のt)は無条件で末尾追加する高速パスのため、
    // dedupチェックを経由しない（下の別テストで明示的に確認する）。
    const hist = [];
    _insertHistoryFrame(hist, { t: 0.1, v: 'first' });
    _insertHistoryFrame(hist, { t: 0.2, v: 'second' });
    _insertHistoryFrame(hist, { t: 0.1005, v: 'third' }); // 逆行して再訪問、0.1と0.5ms差
    assert.equal(hist.length, 2); // 新規フレームにならず上書きされる
    assert.equal(hist.find(f => Math.abs(f.t - 0.1) < 0.001).v, 'third');
});

test('_insertHistoryFrame: 順再生の高速パスはdedupチェックを経由しない（設計上の既知の境界）', () => {
    // 通常の30fps再生ではフレーム間隔が33ms程度あるため実害はないが、
    // 仮に1ms未満の間隔で forward 方向の呼び出しが来た場合、
    // 高速パス(frame.t > 最後の要素のt)は無条件でpushするため重複が作られうる。
    // これは意図的な設計（動作を変えず挙動を記録するテスト）であり、
    // 「バグ」として修正はしない。将来この境界を変える場合はこのテストを更新すること。
    const hist = [];
    _insertHistoryFrame(hist, { t: 0.1 });
    _insertHistoryFrame(hist, { t: 0.1005 }); // 順方向、0.5ms差
    assert.equal(hist.length, 2); // dedupされない（高速パスのため）
});

test('_insertHistoryFrame: 1ms以上離れていれば別フレームとして扱う', () => {
    const hist = [];
    _insertHistoryFrame(hist, { t: 0.1 });
    _insertHistoryFrame(hist, { t: 0.1015 }); // 1.5ms差
    assert.equal(hist.length, 2);
});

test('_insertHistoryFrame: 複数回の逆行シーク（AB往復相当）でも常にt昇順', () => {
    const hist = [];
    const sequence = [0.5, 0.6, 0.7, 0.5, 0.55, 0.6, 0.65, 0.5, 0.52];
    for (const t of sequence) _insertHistoryFrame(hist, { t });
    const times = hist.map(f => f.t);
    const sorted = [...times].sort((a, b) => a - b);
    assert.deepEqual(times, sorted);
});

test('_insertHistoryFrame: 挿入位置の境界値（先頭挿入）', () => {
    const hist = [];
    _insertHistoryFrame(hist, { t: 0.5 });
    _insertHistoryFrame(hist, { t: 0.1 }); // 先頭より前
    assert.deepEqual(hist.map(f => f.t), [0.1, 0.5]);
});

test('_histBinarySearch: 空配列は0を返す (クラッシュ防止)', () => {
    assert.equal(_histBinarySearch([], 1.0), 0);
});

test('_histBinarySearch: t以下の最後の要素の次のインデックスを返す', () => {
    const hist = [{ t: 0 }, { t: 0.1 }, { t: 0.2 }, { t: 0.3 }];
    assert.equal(_histBinarySearch(hist, 0.15), 2); // 0.1の次
    assert.equal(_histBinarySearch(hist, 0.2), 3);  // 0.2ぴったり含む
    assert.equal(_histBinarySearch(hist, -1), 0);   // 全部より前
    assert.equal(_histBinarySearch(hist, 999), 4);  // 全部より後
});

test('_histBinarySearch: 上限はhist.lengthに固定される', () => {
    const hist = [{ t: 0 }, { t: 1 }];
    assert.equal(_histBinarySearch(hist, 100), 2);
});

test('_insertHistoryFrame → _histBinarySearch: 逆行挿入後も検索が正しく機能する', () => {
    // C-1が実際に壊していたシナリオ: 逆行挿入で非単調になると
    // _histBinarySearch の結果が信用できなくなる。挿入後に検索して確認する。
    const hist = [];
    for (const t of [0.0, 0.3, 0.1, 0.2]) _insertHistoryFrame(hist, { t });
    // この時点で hist は [0.0, 0.1, 0.2, 0.3] のはず
    assert.deepEqual(hist.map(f => f.t), [0.0, 0.1, 0.2, 0.3]);
    assert.equal(_histBinarySearch(hist, 0.15), 2);
});
