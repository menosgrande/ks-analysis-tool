# State Management Reference

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
  → state.abJumping = true      // history.push をブロック
  → state.seekGeneration++
  → video.currentTime = state.repeatA
  → video.addEventListener('seeked', releaseJump, { once: true })
  → setTimeout(releaseJump, 200)  // seeked が来ない場合の安全策
  → releaseJump: state.abJumping = false
```

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
