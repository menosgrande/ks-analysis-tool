# KANSETSU-SCOPE（関節スコープ）

> **ブラウザで動く、動画ベースの関節角度解析ツール**  
> MediaPipe PoseLandmarker + Three.js による 2D/3D 姿勢解析

---

## 概要

ローカル動画をブラウザに読み込むだけで、骨格の 2D/3D 描画・関節角度のグラフ表示・軌跡トレース・解析データのエクスポートが行えるシングルファイル Web アプリ。

- **インストール不要** — `index.html` をブラウザで開くだけ
- **サーバー不要** — すべての処理はクライアントサイドで完結
- **外部依存は CDN のみ** — Three.js / MediaPipe Tasks API / Font Awesome

---

## 機能一覧

| 機能 | 説明 |
|---|---|
| 2D 骨格描画 | 動画フレームに骨格・関節ドット・角度ラベルを重ね描き |
| 3D 骨格表示 | world 座標を腰中心ローカル座標に変換して Three.js で描画 |
| 角度グラフ | 最大 3 関節の角度時系列をリアルタイム表示（graph-overlay） |
| 軌跡（Trail） | 指定した関節の 2D/3D 軌跡を描画 |
| A/B リピート | A〜B 点のループ再生。シークバーのハイライト帯をドラッグで編集 |
| 区間保存 | A/B 区間に色を付けて複数保存・クリックで切り替え |
| 解析データ保存 | JSON（骨格・角度データ全体） / CSV（角度のみ） |
| 動画録画 | 2D 合成 / 3D 独立を MP4 または WebM で録画 |
| GIF 出力 | A/B 区間のスケルトンアニメを gif.js で書き出し |
| PNG 保存 | 現在フレームの 2D 合成画面を PNG で保存 |
| モデル切替 | Lite / Full / Heavy を実行時に切替可能 |
| EMA スムージング | 2D・3D 座標それぞれに独立した指数移動平均フィルタ |

---

## 使い方

### 基本ワークフロー

```
1. ブラウザで index.html を開く（推奨：ローカルサーバー経由）
2. 「動画を開く」でローカル動画ファイルを選択
3. MediaPipe が自動初期化され、最初のフレームを解析
4. ▶ 再生ボタン → 骨格が動画に追従して描画される
5. サイドバーの 👁 ボタン → グラフにその関節を追加
6. サイドバーの 〜 ボタン → その関節の軌跡を描画
```

### A/B リピート

```
A ボタン → 現在位置を A 点にセット（シークバーに黄色マーカー）
B ボタン → 現在位置を B 点にセット（シークバーに青色マーカー）

シークバーのハイライト帯：
  左端ドラッグ → A 点を移動
  右端ドラッグ → B 点を移動
  中央ドラッグ → 区間ごと移動

🔖 ボタン → 現在の A/B 区間をチップとして保存
```

### データの活用

```
データ ▾ → 解析データを保存 (.json)
  骨格・角度データを一括保存。
  次回「解析データを読み込む」で動画がなくても 3D・グラフを再現できる。

データ ▾ → 角度データを CSV で保存
  各フレームの関節角度を Excel / スプレッドシートで開ける形式で出力。
```

---

## アーキテクチャ

```
動画ファイル
    ↓ URL.createObjectURL
<video> 要素
    ↓ detectForVideo（startRenderLoop / seekAndDetect）
MediaPipe PoseLandmarker
    ↓                            ↓
result.landmarks[0]      result.worldLandmarks[0]
smoothLandmarks (EMA)    convertWorldToLocal → smoothWorldLandmarks (EMA)
    ↓                            ↓
lm（2D 正規化座標）        worldLocal（腰中心ローカル座標）
    ↓                            ↓
draw2D (canvas-2d)         draw3D (Three.js)
update2DTrail              update3DTrail（シングルトン Line）
    ↓                            ↓
drawGraph (graph-overlay)  animate (OrbitControls)
    ↓
state.history.push(compactFrame)  ← 最大 18,000 フレーム（≈10 分 @ 30fps）
```

### 角度計算の流れ

```
worldLocal[pts[0]], worldLocal[pts[1]], worldLocal[pts[2]]
    ↓ calcAngle3D()
3 点から余弦定理で 0〜180°
    ↓ 関節種別補正
肘・膝・股関節: abs(180 - θ)  ← 屈曲角を返す
足首: θ - 90
その他: θ そのまま
```

---

## 技術スタック

| ライブラリ | バージョン | 用途 |
|---|---|---|
| MediaPipe Tasks Vision | 0.10.14 | 姿勢推定（PoseLandmarker） |
| Three.js | r128 | 3D レンダリング |
| OrbitControls | r128 | 3D カメラ操作 |
| Font Awesome | 6.0.0 | アイコン |
| gif.js | 0.2.0 | GIF 書き出し（動的ロード） |

> **Three.js r128 について**: `examples/js/` グローバルスクリプト方式の最後の安定世代。r152 以降は ES Modules 専用のため、ビルドステップなしの単一ファイル構成では r128 または r150 が上限。

---

## プロジェクト構成

```
ks-analysis-tool-main/
├── index.html    # アプリ本体（CSS・JS・HTML すべて内包）
├── README.md     # このファイル
└── STATE.md      # state オブジェクト完全リファレンス
```

---

## ブラウザ互換性

| ブラウザ | 対応 |
|---|---|
| Chrome 110+ | ✅ 完全対応（推奨） |
| Edge 110+ | ✅ 完全対応 |
| Firefox 120+ | ✅ 対応（MP4 録画は WebM にフォールバック） |
| Safari 16+ (macOS) | ⚠️ 部分対応（captureStream 制限あり） |
| iOS Safari 16+ | ⚠️ 部分対応（再生・解析は動作、録画は制限あり） |

---

## ローカルで開く

```bash
# Python 3
python3 -m http.server 8080

# Node.js
npx serve .
```

`file://` 直接開きでも動作しますが、一部ブラウザでは CORS 制限を受けるためローカルサーバー経由を推奨。

---

## 既知の制限・注意点

- **history 肥大化**: 18,000 フレーム（≈10 分）を超えると古いデータを削除。長時間解析は注意
- **MediaPipe GPU**: 環境によって GPU delegate が失敗する場合あり。その場合 `"CPU"` にフォールバック
- **録画 API**: `captureStream()` は Safari で未対応または制限あり
- **単一ファイル**: 大規模な機能追加時はモジュール分割を検討

---

## 開発で知っておくべき実装の決定事項

| 事項 | 内容 |
|---|---|
| `isEmaResetTriggered` のリセットタイミング | `onPoseResults` の最後にまとめてリセット。`convertWorldToLocal` 内でリセットすると `smoothWorldLandmarks` がズレる（Bug-A） |
| Trail シングルトン | `_trailLine` は初期化時に 1 度だけ追加。毎フレーム `Float32Array` を書き換え `setDrawRange` で制御。`clearGroupChildren + new Geometry` は GC カクつきの原因 |
| `seekAndDetect` | `video.currentTime = t` は非同期。`onseeked` を待ってから `detectForVideo` を呼ぶ |
| `abJumping` フラグ | `true` の間は `history.push` のみスキップ。描画は継続する（以前は全体 `return` で骨格が消えていた） |
| `lastVideoTime` との比較 | `renderLoop` 内で同一フレームへの重複検出を防ぐ。MediaPipe は同じタイムスタンプに `landmarks:[]` を返す |
