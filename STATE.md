# STATE.md — KANSETSU-SCOPE プロジェクト全体

> 以前は `ks_project/STATE.md` と `pose_diagnostics/STATE.md` の2ファイルに分かれていたが、
> 表示名が同じ「STATE」になり見分けがつかなくなったため、1ファイルに統合した。
> 中身は削らずそのまま統合している（Part 1 = 旧ks_project/STATE.md、Part 2 = 旧pose_diagnostics/STATE.md）。

## プロジェクトフェーズ

- **Phase 1（完了）**：主要機能・UX・外部レビュー対応（C-1, M-2, M-3, M-5, M-6, UX-1）
- **Phase 2（進行中、方針転換）**：解析基盤を固める（A-3, M-1）。当初は「設計を固めてから
  実装」で進めていたが、調査・診断・設計整理に十分時間を使ったため、**実装しながら
  設計を固める**方針に転換した（詳細はPart 1「M-1 — 実装しながら設計する方針に変更」）
- **Phase 3（並行可）**：2動画比較等の新機能。M-1完了を待たず、M-1で切り出した構造を
  使ってプロトタイプが作れそうなら並行して着手してよい

## 現在地サマリー（まずここだけ読めばよい）

**クローズ済み**：C-1, M-2, M-3, M-5, M-6（Part 1「外部レビュー対応ログ」参照）

**進行中・未着手**

| 項目 | 状態 | 詳細 |
|---|---|---|
| UX-1（未読込CTA・D&D・機能状態制御） | 実装完了、実環境Smoke E2Eのみ未実施 | Part 1 |
| UX-2（モバイルUIの乱雑さ） | 原因診断のみ完了、未着手 | Part 1 |
| A-3（Pose安定性・破綻条件診断） | 診断ツール完成、動画を目視して動作フェーズと対応付ける作業が残り。**これ以上ツールを肥大化させない**。確認したらそこで終了 | Part 2 |
| M-1（app.js分割） | 未着手。**方針転換**：事前に設計を固めず、実装しながら責務境界を切り出し、Reliabilityの置き場所やテストもその都度追加していく（詳細はPart 1「M-1 — 実装しながら設計する方針に変更」） | Part 1 |

**優先順位**：①UX-2原因A（バグ、即修正） → ②A-3を今ある結果で終了 → ③M-1着手（実装しながら
責務分離・Reliability組み込み・状態遷移テストをその都度追加） → ④途中で使えそうな新機能
（2動画比較等）が見えたらプロトタイプ → ⑤フィルタリング再評価は実データを見て必要なら

**重要な設計上の警告（A-3の発見、確定事項・維持）**：`hip_r visibility=100%` でも一定の
角度スパイクが出た。**visibilityが高い＝解析値が安定、ではない**。M-1でReliabilityを
どこかに組み込む際、「visibilityが高ければ安全」という前提を混入させないこと。

---

## Part 1: App本体 (`ks_project/`) — State Management Reference

> コード本体は `ks_project/app.js`（`index.html` から読み込み）にある。
> 以下は `app.js` 内のロジックを指すドキュメント。

`state` オブジェクトはアプリ全体の唯一の真実の源（Single Source of Truth）。  
`const state = { ... }` として宣言され、すべての関数から参照・更新される。

> **ファイル構成について**: `state` の宣言・全ロジックは `app.js` にある（`index.html` から
> `<script src="app.js">` で読み込み）。本ドキュメントの記述は `app.js` 内のコードを指す。

---

## 全フィールド一覧

### 再生制御

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `isPlaying` | boolean | `false` | 再生中かどうか。`togglePlay()` で反転 |
| `loopRunning` | boolean | `false` | `startRenderLoop()` が走っているか。2 重起動防止フラグ |
| `videoDuration` | number | `0` | 動画の長さ（秒）。`onloadedmetadata` で設定 |
| `currentFileName` | string\|null | `null` | 現在開いている動画のファイル名 |
| `graphMode` | `'angle'\|'velocity'\|'accel'` | `'angle'` | 角度グラフの表示モード。`setGraphMode()` で切替 |
| `calibration` | `Calibration`\|null | `null` | 実寸(cm)キャリブレーション結果 |

```ts
type Calibration = {
  p1: {x:number,y:number}; p2: {x:number,y:number}; // 正規化座標(0〜1)
  realCm: number;       // ユーザー入力の実測距離
  pxDistance: number;   // 動画ネイティブ解像度でのピクセル距離
  pxPerCm: number;      // pxDistance / realCm
  videoWidth: number; videoHeight: number; // キャリブレーション時の動画解像度
  calibratedAt: number; // Date.now()
}
```

### A/B リピート

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `repeatA` | number\|null | `null` | A 点の時刻（秒） |
| `repeatB` | number\|null | `null` | B 点の時刻（秒）。A < B でないと swap される |
| `seekGeneration` | number | `0` | AB ジャンプのたびにインクリメント。古い非同期処理を破棄するために使う |
| `abJumping` | boolean | `false` | AB ジャンプ中フラグ。`true` の間は `history.push` をスキップするが描画は継続 |
| `isStepping` | boolean | `false` | コマ送り中フラグ。AB ループをバイパスする |

### 区間保存（セグメント）

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `segments` | `Segment[]` | `[]` | 保存された A/B 区間の配列 |
| `segColors` | `string[]` | 6 色配列 | チップの色をローテーションで割り当てる |

```ts
type Segment = {
  id: number;      // Date.now()
  name: string;    // "区間 1" など
  a: number;       // A 点（秒）
  b: number;       // B 点（秒）
  color: string;   // "#58a6ff" など
}
```

### 関節・グラフ制御

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `graphJoints` | `string[]` | `[]` | グラフに表示する関節 ID の配列。最大 3 個。超えたら `shift()` |
| `visibleJoints` | `Set<string>` | `Set()` | サイドバーに表示されている関節 ID のセット（`refreshJointUI` で使用） |
| `hoverJoint` | string\|null | `null` | マウスホバー中の関節 ID |
| `activeSpotIndex` | number\|null | `null` | スポット（目ボタン）で選択中の landmark インデックス（`pts[1]` 値） |
| `activeSpotJoint` | string\|null | `null` | 後方互換用。現在は `activeSpotIndex` を優先 |
| `activeTrailIndex` | number\|null | `null` | 軌跡（〜ボタン）で選択中の landmark インデックス |

### 解析履歴

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `history` | `CompactFrame[]` | `[]` | フレームごとの解析結果。`onPoseResults` で `push` |
| `maxHistory` | number | `18000` | 上限フレーム数（≈10 分 @ 30fps）。超えたら先頭 10% を削除 |

```ts
type CompactFrame = {
  t: number;                  // video.currentTime（秒、小数 3 桁）
  l: Landmark2D[];            // 2D 正規化座標 33 点 { x, y, z, visibility }
  w: Landmark3D[] | null;     // world ローカル座標 33 点 { x, y, z, visibility }
  a: Record<string, number | null>;  // 関節 ID → 角度（度）
}
```

### スムージング・フィルタ

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `emaAlpha` | number | `0.5` | EMA 係数。1.0 = スムージングなし（生データ）、0.1 = 最大スムージング |
| `smoothedLandmarks` | `Landmark2D[]`\|null | `null` | 2D EMA バッファ |
| `smoothedWorldLandmarks` | `Landmark3D[]`\|null | `null` | 3D world EMA バッファ |
| `lastReliableLandmarks` | 簡易配列\|null | `null` | 前フレームの 2D ランドマーク（速度フィルタ用） |
| `visibilityThreshold` | number | `0.75` | この値未満の visibility を持つ点は描画・計算から除外 |
| `isEmaResetTriggered` | boolean | `false` | `true` のとき次の `smoothLandmarks` / `smoothWorldLandmarks` 呼び出しでバッファを再初期化 |
| `isSeekingFrame` | boolean | `false` | `seekAndDetect` 中の排他ロック |
| `isModelChanging` | boolean | `false` | モデル再構成中フラグ。`detectForVideo` の並行呼び出しを防ぐ |

### 3D 座標系

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `worldOrigin` | `{x,y,z}`\|null | `null` | 腰中心座標（左右腰の中点）。`convertWorldToLocal` で設定 |
| `relativeOriginMode` | boolean | `true` | `true` = 毎回腰を (0,0,0) に固定。`false` = 生の world 座標を使用 |
| `lastWorldLocal` | `Landmark3D[]`\|null | `null` | 最後に成功した world ローカル座標（フレームスキップ時のフォールバック） |

### 描画パラメータ — 2D

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `alphaSkeleton` | number | `0.5` | スケルトン線の不透明度（0〜1） |
| `alphaGraph` | number | `0.5` | グラフ対象関節ドットの不透明度 |
| `alphaSpot` | number | `1.0` | スポット強調の不透明度 |
| `dotSize2D` | number | `6` | 2D 関節ドットの半径（px） |
| `labelFontSize` | number | `14` | 角度テキストのフォントサイズ（px） |
| `labelOffsetX` | number | `10` | 角度テキストの X オフセット（px） |
| `labelOffsetY` | number | `-10` | 角度テキストの Y オフセット（px） |
| `displayHalfRate` | boolean | `false` | `true` = 角度テキストを 2 フレームに 1 回だけ更新（チカチカ低減） |
| `_displayFrameCount` | number | `0` | 半分レート制御用の内部カウンタ |

### 描画パラメータ — 3D

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `scale3D` | number | `1.5` | world ローカル座標のスケール係数 |
| `sphereSize` | number | `0.02` | 通常の 3D ドット半径 |
| `sphereSpotSize` | number | `0.03` | スポット時の 3D ドット半径 |
| `lineOpacity3D` | number | `0.9` | 3D スケルトン線の不透明度 |
| `trailOpacity` | number | `0.45` | Trail の不透明度 |
| `trailResolution` | number | `3` | Trail CatmullRom の解像度係数（未使用、シングルトン化により固定） |
| `trailLength` | number | `30` | Trail として表示する過去フレーム数 |
| `showDots` | boolean | `true` | 3D ドット（球体）の表示/非表示 |
| `needsRender3D` | boolean | `false` | Three.js の再描画が必要かどうか。`animate()` が参照 |

### UI 状態

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `dragging` | `DragState` | `{ type: null, ... }` | シークバードラッグの状態 |
| `tapFlash` | `TapFlash`\|null | `null` | タップ選択時のフラッシュアニメ情報 |
| `tapFlashUseShadow` | boolean\|null | `null` | `shadowBlur` の使用可否（パフォーマンス計測結果を格納） |

```ts
type DragState = {
  type: 'handle' | 'A' | 'B' | 'highlight-move' | null;
  startX: number;   // ドラッグ開始時の getSeekRatio 値
  startA: number;   // ドラッグ開始時の repeatA
  startB: number;   // ドラッグ開始時の repeatB
}

type TapFlash = {
  jointId: string;
  startTime: number;  // performance.now()
}
```

### 内部・デバッグ

| フィールド | 型 | 初期値 | 説明 |
|---|---|---|---|
| `videoSwitchCount` | number | `0` | 動画切替回数カウンタ（WASM ヒープ断片化対策） |
| `baseWidth` | number | `1280` | 録画用のベース解像度（動画読込時に更新） |
| `baseHeight` | number | `720` | 録画用のベース解像度（動画読込時に更新） |

---

## state と連動するモジュール変数

`state` 以外にも以下のモジュールレベル変数が状態を持つ。

| 変数 | 説明 |
|---|---|
| `detector` | MediaPipe `PoseLandmarker` のインスタンス |
| `lastPoseSendTime` | 最後に `detectForVideo` を呼んだ `video.currentTime`（重複呼び出し防止） |
| `_renderLoopRaf` | `startRenderLoop` の `requestAnimationFrame` ID。`cancelAnimationFrame` に使う |
| `_seekToken` | `seekAndDetect` の非同期キャンセルトークン |
| `_trailGeo` / `_trailMat` / `_trailLine` | Trail シングルトン（Three.js オブジェクト） |
| `_TRAIL_MAX_PTS` / `_trailPositions` | Trail の Float32Array バッファ |
| `_rec2dRunning` / `_rec3dRunning` | 録画中フラグ |
| `_isMediaPipeInitializing` | MediaPipe 多重初期化防止フラグ |
| `_gifExportRunning` | GIF エクスポート中フラグ |
| `_lastRomData` | ROM レポートの直近の集計結果（`exportRomCSV` が参照する）。`renderRomReport` 実行のたびに上書き |

---

## 状態遷移の主要パターン

### 動画ファイル読み込み時

```
file-input.onchange
  → revokeCurrentVideoObjectURL()   // 旧 URL を解放
  → state.history = []
  → state.smoothedLandmarks = null
  → state.smoothedWorldLandmarks = null
  → state.abJumping = false
  → video.src = new URL
  → video.onloadedmetadata
      → state.videoDuration = video.duration
      → updateSeekbarVisual()
      → video.currentTime = 0
      → video.onseeked → detectForVideo → onPoseResults
```

### シーク時

```
seekAndDetect(t)
  → state.isSeekingFrame = true
  → state.isEmaResetTriggered = true   // EMA をリセット
  → video.currentTime = t
  → video.onseeked
      → detectForVideo(video, performance.now())
      → onPoseResults(result)
          → smoothLandmarks(lmRaw)     // EMA バッファ再初期化
          → convertWorldToLocal()      // worldOrigin 更新
          → smoothWorldLandmarks()     // 3D EMA バッファ再初期化
          → isEmaResetTriggered = false  ← ここで一括リセット
      → state.isSeekingFrame = false
```

### AB ジャンプ時

```
updateUI (renderLoop 内)
  → video.currentTime >= state.repeatB を検出
  → state.abJumping = true      // history 記録をブロック（★ Bug-C1 fix 済み）
  → state.seekGeneration++
  → video.currentTime = state.repeatA
  → video.addEventListener('seeked', releaseJump, { once: true })
  → setTimeout(releaseJump, 200)  // seeked が来ない場合の安全策
  → releaseJump: state.abJumping = false
```

> **★ Bug-C1（外部レビューで指摘・修正済み）**: 以前は `onPoseResults()` 内で
> `state.history.push(compactFrame)` が `if (state.abJumping) return;` より
> **先に**実行されており、コメント上は「history記録をブロック」となっていたが
> 実際にはブロックされていなかった。さらに `seekAndDetect()`
> （シークバー操作等の任意方向シーク）は `abJumping` を経由せず
> `onPoseResults` を直接呼ぶため、逆方向シークで `state.history` の `t` が
> 非単調になり得た。`_histBinarySearch()` は `t` 昇順を前提とするため、
> グラフ・ROM等の「現在時刻付近を検索する」処理が不正な範囲を参照する
> 可能性があった。
>
> **修正内容**: `state.history.push()` を廃止し、`_insertHistoryFrame()`
> （二分探索による挿入・同時刻フレームの上書き）に置き換え。合わせて
> `push` 呼び出し自体を `!state.abJumping` でガードする位置に修正し、
> 「順再生は末尾追加の高速パス」「逆行・シークは挿入」の両方で常に
> `t` 昇順・重複なしが保たれるようにした。

### EMA リセットが必要なタイミング

`state.isEmaResetTriggered = true` を立てるべき場面：

- シーク（`seekAndDetect`）
- AB ジャンプ（`updateUI` の AB チェック）
- 動画ファイル切替（`file-input.onchange`）
- モデル切替（`apply-model-btn` の処理）
- 録画開始（原点をリセットして新鮮な解析から始めるため）

---

## 角度計算の対象関節

| joint ID | 表示名 | pts（3 点のランドマーク番号） | 補正 |
|---|---|---|---|
| `shoulder_l` | 左肩 | [13, **11**, 23] | なし |
| `shoulder_r` | 右肩 | [14, **12**, 24] | なし |
| `elbow_l` | 左肘 | [11, **13**, 15] | `abs(180 - θ)` |
| `elbow_r` | 右肘 | [12, **14**, 16] | `abs(180 - θ)` |
| `wrist_l` | 左手首 | [13, **15**, 17] | なし |
| `wrist_r` | 右手首 | [14, **16**, 18] | なし |
| `hip_l` | 左股関節 | [11, **23**, 25] | `abs(180 - θ)` |
| `hip_r` | 右股関節 | [12, **24**, 26] | `abs(180 - θ)` |
| `knee_l` | 左膝 | [23, **25**, 27] | `abs(180 - θ)` |
| `knee_r` | 右膝 | [24, **26**, 28] | `abs(180 - θ)` |
| `ankle_l` | 左足首 | [25, **27**, 31] | `θ - 90` |
| `ankle_r` | 右足首 | [26, **28**, 32] | `θ - 90` |
| `neck` | 首(推) | [0, **11**, 12] | なし |
| `spine` | 背骨 | [0, **11**, 23] | なし |

`pts[1]`（太字）が角度計算の頂点。`indexToJointId[pts[1]]` で逆引き可能。

---

## compactFrame の JSON 構造

`exportJSON()` が出力するデータの構造：

```json
{
  "meta": {
    "app": "KANSETSU-SCOPE",
    "version": "v15i",
    "exportedAt": "2025-01-01T00:00:00.000Z",
    "fileName": "sample.mp4"
  },
  "frames": [
    {
      "t": 0.033,
      "l": [
        { "x": 0.5123, "y": 0.2341, "z": -0.0123, "visibility": 0.98 }
        // ... 33 点
      ],
      "w": [
        { "x": 0.012, "y": -0.345, "z": 0.012, "visibility": 0.95 }
        // ... 33 点（null の場合あり）
      ],
      "a": {
        "shoulder_r": 111.2,
        "elbow_r": 23.0,
        "wrist_r": 170.0,
        "shoulder_l": 42.0,
        "elbow_l": 49.6,
        "wrist_l": 155.4
        // ... 全 14 関節
      }
    }
  ]
}
```

`importJSON()` でこの形式を読み込むと、`state.history` が復元されグラフ・Trail・3D が再現できる。

**入力検証（外部レビュー M-2 対応）**: `importJSON()` は `JSON.parse()` 直後に
`state` を書き換えず、必ず `validateImportedData(data)` → `normalizeImportedData(data)`
→ 一括代入、の順で処理する。検証NGの場合は `state` を一切変更しない
（部分的にデータが投入されて中途半端な状態になることを防ぐ）。

| 関数 | 役割 |
|---|---|
| `validateImportedData(data)` | `history` が配列か・空でないか・上限（`_IMPORT_MAX_FRAMES`=50000）以内か、各フレームの `t`（有限数・0以上）、`l`/`w`（座標が有限数、`null`要素は許容）、`a`（オブジェクトで値が有限数か`null`）を検証。副作用なし、`{ok, errors}` を返すだけ |
| `normalizeImportedData(data)` | 検証済みデータをフィールド名の揺れ（`t`/`time`, `l`/`landmarks`, `w`/`world`, `a`/`angles`）を吸収しつつ正規化し、`t` 昇順にソートして返す |

正規化後は `t` 昇順が保証されるため、`_histBinarySearch()` の前提を壊さない
（`_insertHistoryFrame()` と合わせて「`history` は常に `t` 昇順・型が正しい」という
不変条件をアプリ全体で維持する設計）。

---

## ROM（可動域）レポート

`state.history`（または選択範囲）から関節ごとの可動域を集計する機能。`state` 自体には
恒久フィールドを追加せず、モジュール変数 `_lastRomData` に直近の集計結果を保持する設計。

| 関数 | 役割 |
|---|---|
| `openRomModal()` | `state.history` が空でないか確認 → 範囲セレクトを再構築 → `renderRomReport()` → モーダル表示 |
| `closeRomModal()` | モーダルを閉じるのみ |
| `_populateRomScopeOptions()` | 「全体」「現在の A/B 区間（設定時のみ）」「保存済み区間（`state.segments` 全件）」を `<select>` に反映。直前の選択値が消えていなければ維持 |
| `_getRomScopeFrames(scope)` | `scope` に応じて `state.history` を時刻でフィルタして返す |
| `computeROM(frames)` | 全 14 関節について `min` / `max` / `rom`(=max-min) / `mean` / `tMin` / `tMax` / `count` を算出。角度が一度も取れなかった関節は `count:0` で返す |
| `renderRomReport()` | 現在の範囲選択で `computeROM` を実行し、`_lastRomData` に保存 → テーブル HTML を描画 |
| `exportRomCSV()` | `_lastRomData` を CSV 化してダウンロード（`_lastRomData` が `null` なら何もしない） |

範囲選択（scope）の値: `'all'` / `'ab'` / `'seg:<segment.id>'`。`_getRomScopeFrames` 内で
`state.repeatA`/`state.repeatB` または該当 `segment.a`/`segment.b` の min/max を範囲として
`history` を `t` でフィルタする。

---

## 角速度・角加速度グラフ

`drawGraph()` は `state.graphMode` を見て描画関数を振り分けるだけの薄いディスパッチャに変更。
実際の描画は角度用と速度/加速度用で分離した。

| 関数 | 役割 |
|---|---|
| `drawGraph()` | サイズ確定・`_histBinarySearch` で現在位置取得 → `graphMode` に応じて `_drawAngleGraph` / `_drawDerivativeGraph` を呼ぶ → カーソル線を描画 |
| `_drawAngleGraph(ctx,W,H,start,pos,len)` | 従来ロジックそのまま。0〜180° 固定スケールで角度の時系列を描画 |
| `_diffSeries(values, times)` | 配列 `values` の隣接差分を `times` の時刻差で割って返す（有限差分）。`dt <= 0` または `dt > _MAX_DT_GAP`(0.5秒) の箇所は `null` にして不連続を明示 |
| `_drawDerivativeGraph(ctx,W,H,start,pos,len,mode)` | 角度配列に `_diffSeries` を1回適用すると角速度、2回適用すると角加速度。表示ウィンドウ内の最大絶対値から自動スケール（0 を中心に対称）してガイドライン・折れ線を描画。`null` 箇所で `started=false` にしてポリラインを分断 |
| `setGraphMode(mode)` | `state.graphMode` を更新し、`.graph-mode-btn` の `active` クラスを切替 → 即座に `drawGraph()` を呼んで一時停止中でも反映 |

`mode` の値: `'angle'` / `'velocity'` / `'accel'`。UI は `#graph-mode-toggle` 内の3ボタン
（`index.html`）。

---

## 実寸(cm)キャリブレーション・距離計測

動画上で2点をクリックする操作を汎用化した `_startTwoPointCapture()` を中核に、
キャリブレーションと距離計測の両方がこれを再利用する設計。

| 関数 | 役割 |
|---|---|
| `_calibGetVideoRenderRect()` | `canvas-2d` の表示サイズと動画解像度から `object-fit:contain` のレンダリング矩形（オフセット・スケール）を計算 |
| `_calibClientToNorm(clientX, clientY)` | クリック位置（ビューポート座標）→ 正規化座標(0〜1)。映像エリア外なら `null` |
| `_calibPxDistanceNative(p1, p2)` | 正規化座標2点間の距離を、動画ネイティブ解像度のピクセル単位に変換して返す |
| `_startTwoPointCapture(bannerText, onComplete)` | `#calib-click-layer` を表示してクリックを2回捕捉。完了時に `onComplete(p1, p2)` を呼ぶ。動画未読込ならアラートして中止 |
| `_handleCalibClick(e)` | クリックのたびに座標を記録・マーカー描画。2点集まったら捕捉を終了して `onComplete` を実行 |
| `cancelTwoPointCapture()` | 捕捉中断（バナーの「キャンセル」ボタン、モーダル背景クリックから呼ばれる） |
| `startCalibration()` | 2点捕捉 → `#calib-input-modal` を開いて実測cm入力を要求 |
| `confirmCalibrationInput()` | 入力値を検証し `state.calibration` を確定（`pxPerCm = pxDistance / realCm`） |
| `startMeasurement()` | `state.calibration` が無ければアラートして中止。動画解像度がキャリブレーション時と異なる場合は確認ダイアログ。2点捕捉後、実寸cmを `#measure-result-modal` に表示 |
| `closeMeasureResult()` | 計測結果モーダルを閉じるのみ |

**注意点**
- `state.calibration` は動画切替時に自動クリアされない（意図的：同一カメラ位置で撮影した
  別動画に使い回すケースを想定）。解像度が変わった場合は `startMeasurement()` 内で警告する
- キャリブレーション自体の精度は「カメラが被写体に対して正面・水平から撮影されている」
  ことを前提とする単純な2D比例計算。奥行き方向の誤差（パースペクティブ）は補正していない
- 「データ▾」メニューの「実寸(cm)キャリブレーション」項目には `#calib-status-badge` が
  付随し、`_updateCalibBadge()` が `state.calibration` の有無で「未設定」/「設定済み」を
  切替表示する（`toggleDataMenu()` を開くたびと、`confirmCalibrationInput()` 完了時に更新）
- **精度限界の明示（外部レビュー M-3 対応）**: キャリブレーション入力モーダル・計測結果
  モーダル・データメニューのツールチップ・確定時アラートの4箇所に「2D画像上の比例換算に
  よる推定値であり、透視投影や奥行きの違いにより誤差が生じる」旨の注記（`.calib-disclaimer`）
  を追加。計算ロジック自体（2D比例換算）は変更していない

---

## UI 分かりやすさ改善（凡例・メニュー見出し）

| 要素 | 説明 |
|---|---|
| `#graph-legend` | グラフに表示中の関節名と線の色を対応付ける凡例。`drawGraph()` 内で `_updateGraphLegend()` が更新（`state.graphJoints` に変化があった時のみ DOM を書き換え、`_lastLegendKey` で差分検知） |
| `.hd-menu-heading` | 「データ▾」メニュー内のセクション見出し（セッション／エクスポート／実寸計測／レポート）。機能が増えても迷わないようグルーピング |
| `.hd-menu-badge` | メニュー項目に付ける状態バッジ。現状はキャリブレーション状態のみ使用 |

---

## 外部レビュー対応ログ（品質改善）

他AIによるコードレビューを受けて実施した修正の記録。

| ID | 指摘内容 | 対応 |
|---|---|---|
| C-1 (Critical) | `state.history` が A/B ジャンプ・任意方向シークで非単調になり得た（`_histBinarySearch()` の前提を破壊） | `_insertHistoryFrame()` で二分探索挿入・同時刻上書きに変更。「history は常に t 昇順」という不変条件を導入。README.mdのアーキテクチャ図が`state.history.push(compactFrame)`のまま古い記述だったのを`_insertHistoryFrame()`呼び出しに修正し実装と一致させた |
| M-2 (Major) | JSON インポートの入力検証が弱く、不正データが `state` に部分投入され得た | `validateImportedData()` / `normalizeImportedData()` を新設。検証NG時は `state` を一切変更しない設計に変更 |
| M-3 (Major) | 実寸(cm)キャリブレーションの精度限界（2D比例換算、パースペクティブ非補正）がUIで説明されていなかった | キャリブレーション入力・計測結果モーダル、メニューのツールチップ、確定時アラートの4箇所に注記を追加。計算ロジックは変更せず |
| M-4 (Major) | 角速度・角加速度が単純な2階有限差分でノイズ増幅の懸念 | コードレビュー段階では「実装バグなし、実動画待ち」と判断。実動画検証の結果、`_diffSeries()`自体の実装は妥当だが、現行パイプラインの加速度は解析値として信頼できないレベルのノイズを持つことを確認。主因はPose推定の信頼性問題（右腕のvisibility不安定）であり、有限差分の増幅特性単体の問題ではないと判明。詳細は本ドキュメントの「Part 2: Pose診断ツール」を参照。A-3は「絶対精度測定」ではなく「安定性・破綻条件の診断」に目的を再定義し、新規動画待ちのブロッカーが解消。既存動画で診断継続中 |
| M-5 (Major) | `clearGroupChildren()` が呼び出し箇所ゼロのデッドコードで、Three.js のプール共有リソースを誤ってdisposeする危険があった | 削除済み |
| M-6 (Major) | 「ES Modules を使わないため file:// 互換」という説明が不正確（MediaPipe自体はCDNからESモジュールを読み込んでいる） | README.md の説明を訂正。「ローカルファイルはclassic script、外部CDNはESモジュールでも file:// で動く」という正確な理由に書き換え、外部依存の一覧表を追加 |
| UX-1 | 初見ユーザー向けの導線が皆無（空のview-boxとヘッダーの小さいボタンのみ、動画依存機能はクリック後にalertで事後通知） | ①未読込時CTA(`#empty-state`)、②view-box全体のドラッグ&ドロップ化(`_initDropZone()`)、④動画/解析データ依存メニュー5項目の状態制御(`_updateFeatureAvailability()`)を実装。実際の関数依存（動画のみ依存 vs history依存）を検証した上でゲート条件を分離。GIF出力のA/B区間要件は既存のdata-tip文言＋実行時ガードのまま維持（3軸目のリアルタイム制御は今回のスコープ外と判断）。初回チュートリアル(③)は①②④の効果を見てから判断する方針で保留。**追記**: ①のCTA文言に「ダーツ投球の動画を選択してください」というダーツ限定の表現を入れてしまっていたが、コードベース全体を調査した結果ダーツ専用の要素はこの1箇所のみと判明。アプリを「汎用動作解析ツール」として位置づけ直す方針のもと、「全身が映った動作の動画を選択してください」に修正（坂口選手動画の検証で判明した「全身が映っていないと解析できない」という制約も自然に文言へ反映） |
| UX-2 (Major, 原因A対応済み) | モバイル(iPhone)で操作がごちゃごちゃして分かりにくい | **原因A（バグ、修正済み）**: カメラ位置ボタン(`.viewport-controls`, 正/側/上)が`.view-split`(2D+3D共通の親)を基準に`position:absolute;top:10px;right:10px`で配置されていた。PC版は`.view-split{display:flex}`(横並び)のため右上が自然に3D側に来るが、`@media(max-width:700px)`で`.view-split{flex-direction:column}`に変わり2D→3D縦積みになった際、`.viewport-controls`は同じ基準のまま右上固定のため2D側の右上に乗っていた。`.viewport-controls`を`#three-container`の子要素に移動することで解決（`#three-container`は既に`.view-box`クラスで`position:relative`済み、Three.jsのcanvasは`appendChild`で追加されるため子要素が消される心配なし）。Playwrightでdesktop(1280px)・mobile(390px)両方の実測で、ボタンが3Dコンテナの範囲内に収まることを確認済み。**原因B（設計課題、未着手）**: 関節タップ選択が動画上の`#tap-select-layer`のみに存在し、角度グラフ(`#graph-overlay`)・数値表示(`#angle-labels`)側にはタップ判定がない。「数値が動いているところを直接タップしたい」という要望あり。動画上タップと数値上タップの両方を同じ選択状態に紐付ける実装が必要、UIの当たり判定設計を要するため原因Aより作業量大 |
| M-1 (Major, 方針転換) | `app.js` 4400行超で責務がすべて1ファイルに同居 | **設計を固めてから実装、ではなく実装しながら設計する方針に転換（詳細は本ドキュメント末尾「M-1 — 実装しながら設計する方針に変更」を参照）** |

---

## M-1 — 実装しながら設計する方針に変更（確定）

> **方針転換（重要）**：ここまで調査・診断・設計整理に時間を使ってきたが、これ以上
> 「設計を固めてから実装」を続けない。ここからは**実装を進めながら設計を固める**。
> 「M-1完了まで新機能は着手しない」という縛りもやめる。以下は事前の完了条件ではなく、
> 実装しながら確認していくチェックリストとして扱う。

### 開発サイクル（今後の基本ルール）

C-1（逆方向Seekでhistoryが非単調になったバグ）のパターンを、今後の開発サイクルの型にする。

```
調査 → 設計 → 実装   ← これはもうやらない
```

```
実装 → 問題発見 → 最小限設計 → 修正 → テスト化 → 次へ   ← これでやる
```

状態遷移契約の回帰テストも「契約書を完成させてから書く」のではなく、**触った状態遷移・
見つけたバグからその都度テストを書く**。C-1のように「バグ修正 → その条件をテストとして
固定」を積み重ねる。

### M-1の進め方

最初から4400行を大量に分割しない。実際にコードを触りながら、責務境界を切り出していく。
目安は以下（確定した最終形ではなく、触りながら見えてくる区切りの出発点）：

```
app.js
 → Pose入力
 → History/Seek/AB
 → 解析値生成
 → Canvas
 → Three.js
 → UI/Menu
 → Export
```

Reliabilityを自然に載せられる場所が見つかったら、そこに組み込む。最初から
`入力Pose → 座標品質/信頼度 → 前処理 → 派生量 → 表示` という理想形を設計してから
分割するのではなく、実装の中で見つけていく。

### 見つけたら確認すること（事前条件ではなくチェックリスト）

- Reliabilityが解析データモデルのどこかに保持されているか（UI表示は必須ではない）
- Pose入力と派生量生成の責務がどこかで分離できているか
- 触った状態遷移（Seek/AB/History/Pose）にテストが付いているか

**設計上の警告（A-3で確定した知見、これは変わらず維持）**：`visibility` はPose Landmarkerの
可視性指標であり、ランドマーク位置や角度系列の時間的安定性を保証しない。A-3で `hip_r` が
`visibility=100%` でも angle spike を示したことを実測で確認済み（本ドキュメント Part 2
参照）。したがって**「visibilityが高い＝解析値を安全に信用できる」という前提を置かない**。
Reliabilityをどこかに組み込む際、この前提を混入させないこと。

### 新機能はM-1完了待ちにしない

2動画比較などの新機能は、M-1が終わってから着手する必要はない。M-1で最初に切り出した
構造を使って小さなプロトタイプを作り、実際に触って使えそうならその場で本実装する。

### 優先順位

```
① UX-2原因A（カメラボタン位置バグ）を潰す — 小さいので即終了
② A-3は今ある結果を確認して終了 — 診断ツールをこれ以上育てない
③ M-1開始 — app.jsを実際に分割しながら、Reliabilityを組み込める場所を探し、
   触った状態遷移にその場でテストを書く
④ 途中で実用的な新機能（2動画比較等）が見えたら、③で切り出した構造を使って
   プロトタイプを作る
⑤ フィルタリング刷新（Butterworth/Kalman等）は実データを見て必要になったら着手
```

### 実施ログ

**① UX-2原因A：修正完了**
`.viewport-controls` を `.view-split` から `#three-container` の子要素に移動。
デスクトップ(1280px)・モバイル(390px)幅の両方でPlaywright実測し、ボタンが
3Dコンテナの範囲内に収まることを確認済み（詳細は本ドキュメント「外部レビュー
対応ログ」UX-2行）。

**③ M-1 最初の切り出し単位：`pose-math.js` を分離**

依存関係が最も少ない「純粋な数学関数」から着手（指示書の推奨順序どおり）。

切り出した関数：`calcAngle3D`（完全に純粋）、`isReliablePoint`（`state.visibilityThreshold`
を参照するが呼び出し側9箇所のシグネチャは変更せず、classic scriptとして同一グローバル
スコープを共有することで対応）、`_diffSeries`・`_MAX_DT_GAP`（完全に純粋）。

- `index.html` に `<script src="pose-math.js">` を `app.js` より前に追加
  （classic script、ES Modules化はしていない。file://互換性を維持）
- 既存の呼び出し箇所（calcAngle3D×1, isReliablePoint×9, _diffSeries×2）は
  一切変更なし。app.js側は関数定義を削除し、参照コメントのみ残した
- `node --check` で両ファイルの構文確認、Playwrightでブラウザ実行時に
  `typeof calcAngle3D === 'function'` 等で実際にグローバルスコープに
  正しく読み込まれていることを確認、`calcAngle3D(90度ケース)` の実行結果も
  期待値と一致することを確認
- **`pose-math.test.js` を新規作成**（`node:test` 標準テストランナー、
  外部フレームワーク不要）。17ケース、全通過。テスト作成中に自作テストの
  誤り（`_diffSeries`のdt閾値を考慮せず1秒間隔のテストデータを使っていた）
  を発見・修正——C-1のパターン（バグ発見→修正→テスト化）をテスト自体の
  検証でも実践する形になった
- Reliability/qualityデータモデルの将来の置き場所として、`pose-math.js`の
  冒頭コメントに位置づけを明記（今回は構造のみ、スコアの実装はしていない）

**次の切り出し候補**：History関連（`_insertHistoryFrame`, `_histBinarySearch`）。
C-1の不変条件（t昇順・重複なし・AB/シーク中の混入防止）をテストとして固定する
のに適した単位。

**③ M-1 2番目の切り出し：`history.js`（History関連）**

着手時点で `history.js` はファイルとしては既に存在していたが、**`index.html`に
読み込みタグがなく、呼び出し側のシグネチャも新形式に追随できていない、壊れた
中間状態**だった（`_insertHistoryFrame(compactFrame)`という旧1引数呼び出しが
残ったまま、実際の定義は新シグネチャ`(hist, frame)`のみ。ブラウザ上では
`_insertHistoryFrame`が未定義エラーになる状態）。前回セッションの続きがどこかで
中断したものと思われる。壊れたまま次に進めず、その場で完了させた。

修正内容：
- `index.html`に`<script src="history.js">`を追加（`pose-math.js`の次、`app.js`より前）
- app.js側に残っていた`_histBinarySearch(t)`の旧実装（`state.history`を暗黙参照する版）
  を削除。`history.js`側の新シグネチャ`_histBinarySearch(hist, t)`が唯一の定義に
- 呼び出し箇所を新シグネチャに合わせて修正：`_insertHistoryFrame(state.history, compactFrame)`
  （1箇所）、`_histBinarySearch(state.history, t)`（Trail更新関数）、
  `_histBinarySearch(state.history, video.currentTime)`（drawGraph）
- `node --check`で構文確認、Playwrightで実ブラウザ実行し、逆行挿入
  （t=[0.0, 0.1, 0.05]の順で挿入）が正しくt昇順`[0, 0.05, 0.1]`を維持することを確認
- `history.test.js`を新規作成（11ケース）。C-1の不変条件（t昇順維持・逆行シークでの
  非単調化防止・重複排除）をテストとして固定。テスト作成中に発見した点：
  重複排除ロジックは「逆行/再訪問パス」でのみ働き、通常の順再生の高速パス
  （`frame.t > 最後の要素.t`で無条件push）はdedupチェックを経由しない設計だった。
  これはバグではなく意図的な設計（30fps再生では1ms未満の間隔が現実的に発生しないため
  実害なし）と判断し、コードは変更せず、この境界をテストとして明示的に記録した
- `pose-math.test.js`と合わせて計28ケース、全通過

**次の切り出し候補**：Reliability/quality情報をデータモデルに組み込む場所の検討。
`isReliablePoint`（pose-math.js）が返す真偽値だけでなく、A-3で使った4層
（visibility/completeness/temporal stability/angle spike）の生値をどこかに
保持できる形に`compactFrame`の構造を拡張できないか、実装しながら検討する。

---

## Part 2: Pose診断ツール (`pose_diagnostics/`) — 調査ログ

> コード本体は `pose_diagnostics/measure.py` にある。

> **現在のステータス: 進行中 (2026-08-26〜)**
> A-1/A-2までの実測は完了。A-3は「絶対精度測定」から**「安定性・破綻条件の診断」**へ
> 目的を変更した（Ground Truthなしに絶対精度は測定できないため）。この再定義により、
> 新規動画（別アングル撮影）待ちというブロッカーが解消され、手元の既存動画だけで
> 進められるようになった。`measure.py`にLayer1-4(visibility/completeness/
> temporal stability/angle spike)、および時系列診断(`--window-sec`、機械的な
> 固定長ウィンドウ分割＋破綻集中区間の自動検出)を実装済み。既存動画での初回実行
> 結果は下記「A-3 時系列診断の初回結果」を参照。次は動作フェーズとの対応付け。

KANSETSU-SCOPE 本体（Part 1）の「外部レビュー対応ログ」の M-4 (角速度/角加速度の
有限差分ノイズ) を実動画で再評価する過程で派生した調査。

## 経緯サマリ

外部レビューで指摘された M-4 (`_diffSeries()` の単純二階有限差分は理論上ノイズを増幅する)
について、当初は「コードレベルではCritical/Major級のバグなし、実動画での観察待ち」として
保留していた。実動画 (ダーツ投球, 720x1280 30fps 約9秒) を用いて検証した結果、
当初の想定より論点が1つ多いことが判明した。

## 確定事項

### M-4 の再評価
`_diffSeries()` 自体の実装に誤りはない (この判断は維持)。ただし実測の結果、
現行パイプラインの出力する加速度は、少なくとも本検証動画においては解析値として
信頼できるレベルにない。理由は主に発見A (下記) にあり、B (有限差分そのものの
ノイズ増幅特性) 単体の問題ではない。

### 発見A: Pose推定の信頼性問題 (M-4より優先度が高いと判断)

**問題の因果連鎖**
```
高速な投球動作
  → 右肘・右手首の追跡が不安定になる (モーションブラー・自己遮蔽)
  → visibilityが低下するが、座標自体は必ずしも破綻していない
  → visibility閾値0.75では投球腕のデータがほぼ消える (安全側)
  → 閾値を緩めると誤差の大きい座標を採用するリスクが上がる (危険側)
  → いずれにせよ角度系列が不安定/欠損する
  → 誤って通過した異常角度は二階差分で加速度スパイクとして増幅される
```

**重要な訂正 (2回発生、両方とも記録する)**

1. 初期仮説「肘・手首が肩や頭付近に誤ってスナップする」→ 座標実測で**否定**。
   低visibility下でも座標自体は妥当な範囲に留まっており、
   「座標は尤もらしいがconfidenceが不安定」という説明の方が実測と整合する。
2. Lite/Full/Heavy比較の初回集計で、reliable率を**関節1点のみのvisibilityチェック**
   で計算してしまい、実際のapp.js角度計算 (3点すべてがreliable必須) と不整合な数値
   (elbow_r: 2.6/19.2/18.8%, wrist_r: 0/6.0/32.7%) を報告した。3点ゲート方式で
   再計算し、以下の正しい数値に訂正した。

**A-1/A-2 実測結果 (正)**

全体検出率・reliable率 (3点ゲート方式、動画全266フレーム):

| model | 全体検出率 | elbow_r reliable% | wrist_r reliable% | hip_r reliable% |
|---|---|---|---|---|
| Lite  | 97.7% | 0.0%  | 0.0%  | 45.1% |
| Full  | 64.7% | 6.0%  | 0.4%  | 31.6% |
| Heavy | 92.9% | 18.4% | 18.4% |  1.9% |

指定フレーム (70, 71, 99, 100, 162, 184, 185) での座標・visibility比較:
- モデルごとに人物全体の検出自体が欠落するフレームが異なる (Liteが最も安定、
  Fullが最も不安定)。「大きいモデルほど安定する」は本動画では成立しない。
- 検出できたフレームでも、visibility絶対値 (0.3〜0.6台) は3モデルでほぼ同水準。
  モデル変更だけではvisibilityの根本的な低さは解消されない。

**hip_r 加速度の交絡について**: Heavyでhip_rの最大加速度が79,201→882まで
下がって見えるが、有効フレームが5点(1.9%)しかなく、差分可能な区間自体が
激減しているだけの疑いが強い。ノイズ改善の証拠としては**採用しない**。

**モデルファイルの真正性**

| モデル | 検証方法 | 判定 |
|---|---|---|
| Lite  | 2つの無関係なリポジトリ間でSHA256完全一致 | 高信頼 |
| Full  | 2つの無関係なリポジトリ間でSHA256完全一致 | 高信頼 |
| Heavy | 1リポジトリのみ (同リポジトリ内の他2ファイルは検証済) | 中信頼・単独ソース |

**現時点の結論 (確定)**

> Aは「Liteの閾値問題」ではなく、「モデルごとの検出安定性 + 高速動作時のPose品質
> + 撮影条件」の複合問題。Heavyには右手首・右肘のreliable率で明確な改善
> (0.0%→18.4%) があるが、モデル単独で解決する問題ではない。この動画・この用途に
> 限定した根拠として扱い、「Heavyが常に優れている」という一般化はしない。

閾値の単純な緩和 (例: 0.75→0.5) は候補から除外済み。低visibility=誤座標とは
限らない一方、visibility0.5前後=正座標とも限らないことが実測で示されたため、
visibility単独では判定能力が不足している。

### 発見B: 有限差分ノイズ (保留継続)
reliableゲートを通過した区間 (hip_r, elbow_l など) では、二階差分による
ノイズは理論通り深刻。加速度標準偏差が数千〜1万台、符号反転率50〜70%
(ランダムノイズに近い挙動)。ただしAの入力品質問題を解決してから再測定しないと、
「純粋な有限差分ノイズ」と「Pose推定誤差由来のスパイク」が分離できないため、
Savitzky-Golay等の対策検討は**まだ着手しない**。

## 未着手・保留事項

| ID | 内容 | 状態 |
|---|---|---|
| A-3 (改訂) | 「絶対精度測定」から「安定性・破綻条件の診断」へ目的変更。`measure.py`に
       Layer1-4(visibility/completeness/temporal stability/angle spike)を実装済み。
       Menoさんの既存動画で、通常区間/テイクバック/リリース付近/フォロースルー/
       崩れている区間を比較する | **今すぐ着手可能**（新規動画待ちのブロッカー解消） |
| A-3-later | 撮影条件を変えた比較 (現在位置/横方向寄り/斜め前方向寄り) は、
       A-3(改訂)で「撮影条件による安定性の違い」が疑われた場合の追加検証として
       位置づけを格下げ。必須ではなくなった | 新規動画が手に入った時の任意タスク |
| A-4 (仮) | reliability判定の複合化 (visibility + temporal stability + angle spike
       + 身体構造整合性) の検討 | A-3(改訂)の診断結果を見てから着手判断。
       複合スコア化は時期尚早、現時点では実装しない |
| B-1 | Pose品質改善後のM-4再測定 | A-3(改訂)完了後 |
| B-2 | Savitzky-Golay等のフィルタ比較 | B-1の結果次第。加速度が依然破綻する場合のみ |

## ツール自体の変更履歴

| 日付 | 内容 |
|---|---|
| 初版 | `measure.py` 作成。3点ゲート方式で reliable率・角度有効フレーム率・
       全体検出率・指定フレーム詳細比較を出力する形で実装 |
| v2 | A-3を「絶対精度測定」から「安定性・破綻条件の診断」へ再定義。Layer1-4を追加：
       ①visibility(点単位、閾値超え率) ②completeness(人物検出率)
       ③temporal stability(生world座標のフレーム間変位を肩幅で正規化、可視性でゲート
       しない) ④angle spike(生角度を角速度[deg/s]換算、EMA平滑化後との比較も出力)。
       4層は独立指標として出力し、複合スコア化はしていない（原因の異なる問題を
       混ぜて隠さないため）。`--spike-threshold`(デフォルト1500deg/s、暫定値)、
       `--skip-stability`オプションを追加 |
| v3 | `--window-sec`オプションで時系列診断を追加。動画を固定長ウィンドウに機械的に
       等分割し(テイクバック/リリース等を人間が事前に選んでバイアスが入ることを回避)、
       ウィンドウごとにvisibility/stability/spike(raw・EMA平滑化後の両方)を出力。
       raw spike_rate上位を自動抽出する「破綻集中区間の候補」検出
       (`find_breakdown_windows()`)を追加 |

## A-3 時系列診断の初回結果 (Menoさんの投球動画、Lite、window=0.5秒)

初回実行 (elbow_r, wrist_r, hip_r) で以下が確認できた。

- **wrist_rの破綻はリリース想定区間に集中している可能性**: raw spike_rate上位5件のうち
  4件がwrist_r（0.5-1.0s: 33%, 5.0-5.5s: 27%, 4.0-4.5s: 27%, 4.5-5.0s: 23%）。
  ただし複数投球を含む動画のため、これが単一のリリース局面を指すのか複数投球分の
  リリースが分散しているのかは、動画を目視して対応付ける必要がある（未実施）
- **hip_rはraw/ema差が窓ごとにばらつく**: 例えば4.5-5.0s窓はraw15%→ema0%（EMA平滑化が
  ほぼ吸収）だが、3.0-3.5s窓はraw13%→ema9%（吸収しきれていない）。単純な高周波ノイズ
  だけでなく、EMA平滑化でも消えない変動が一部の区間に存在する可能性がある
- **elbow_r/wrist_rはspike_ema列が全窓で"-"**: Liteモデルではreliable率が実質0%のため、
  app.jsの実際の出力(EMA平滑化後・ゲート通過)としては、そもそも比較対象となる
  smoothed角度系列が存在しない。rawでの傾向は見えても、「app.jsの出力としてどう
  見えるか」はこの動画・このモデルでは評価不能

**次にやること**: 上記の破綻集中区間の候補（0.5-1.0s, 4.0-5.5s付近）が実際にどの
動作フェーズ（テイクバック/リリース/フォロースルー、または複数投球の切れ目）に
対応するか、動画を目視して対応付ける。それを踏まえて、他の動画（坂口選手動画の
使える区間等）でも同様の時系列診断を行い、パターンが動画をまたいで再現するかを見る。
