    /* ============================================================
       1. State Management
    ============================================================ */
    const state = {
        // --- 既存 ---
        isPlaying: false,
        history: [],
        activeSpotJoint: null,
        activeSpotIndex: null,    // 目ボタン → 中心点ハイライト
        activeTrailIndex: null,   // 軌道ボタン → 2D/3D trail
        graphJoints: [],
        graphMode: 'angle', // 'angle' | 'velocity' | 'accel' — グラフ表示モード
        visibleJoints: new Set(),
        emaAlpha: 0.5,
        trailLength: 30,
        visibilityThreshold: 0.75, 
        showDots: true,
        videoDuration: 0,
        smoothedLandmarks: null,
        hoverJoint: null,
        repeatA: null,
        repeatB: null,
        currentFileName: null,
        calibration: null, // 実寸(cm)キャリブレーション結果。{p1,p2,realCm,pxDistance,pxPerCm,videoWidth,videoHeight,calibratedAt} | null
        dragging: { type: null, startX: 0, startA: null, startB: null },
        loopRunning: false,
        lastReliableLandmarks: null,

        // --- ABループ安定化 ---
        seekGeneration: 0,   // ABジャンプのたびにインクリメント
        abJumping: false,    // ジャンプ中=true → onPoseResults でhistory保存をスキップ
        isStepping: false,   // ★ 修正3: コマ送り中フラグ（A/Bループをバイパスする）
        videoSwitchCount: 0, // ★ 修正3(WASM): 動画切替回数カウンタ（ヒープ断片化対策）

        // --- 区間保存 ---
        segments: [],        // { id, name, a, b, color }
        segColors: ['#58a6ff','#ff7b72','#3fb950','#f1c40f','#bc8cff','#ff9800'],

        // --- 履歴上限 ---
        maxHistory: 18000,   // ~10分 @ 30fps

        // --- 描画パラメータ（2D / 3D 共通） ---
        alphaSkeleton: 0.5,
        alphaGraph: 0.5,
        alphaSpot: 1.0,
        dotSize2D: 6,
        labelFontSize: 14,
        labelOffsetX: 10,
        labelOffsetY: -10,

        // --- 3D ---
        scale3D: 1.5,
        sphereSize: 0.02,
        sphereSpotSize: 0.03,
        lineOpacity3D: 0.9,
        trailOpacity: 0.45,
        trailResolution: 3,

        // --- EMA フィルタ用 ---
        isEmaResetTriggered: false, // シーク / ABワープ直後に EMA をリセットするトリガ
        isSeekingFrame: false,      // seekAndDetect 中の排他ロック
        isModelChanging: false,     // ★ Bug-Q fix: モデル再構成中フラグ（WASM競合防止）
        smoothedWorldLandmarks: null, // ★ world座標の EMA バッファ

        // --- v14.1: 3D相対座標モード ---
        relativeOriginMode: true,   // true = 腰を毎フレーム(0,0,0)固定

        // --- v15i-tap: タップ選択フラッシュ ---
        tapFlash: null,       // { jointId: string, startTime: number } | null
        tapFlashUseShadow: null, // null=未計測 / true=shadowBlur使用 / false=軽量版使用
    };

    const DIAG = { frames: 0, cacheHits: 0, poseSends: 0 };
    let lastPoseSendTime = -Infinity; // ★ Bug-M fix: 0 だと t=0 のときだけキャッシュヒットしてしまう
    let detector = null;

    /* ============================================================
       共通ユーティリティ（修正1〜8 基盤）
    ============================================================ */
    let _renderLoopRaf  = 0;
    let _seekToken      = 0;
    let _pendingSeekTime = null;
    let _videoObjectUrl  = null;
    let _gifExportRunning        = false;
    let _isMediaPipeInitializing = false; // ★ 修正2: MediaPipe 多重初期化防止
    let _gifInstance     = null;  // ★ 修正3: 実行中の GIF インスタンスを保持
    let _resumeAfterVisible = false;

    let _rec2dRaf = 0, _rec2dStream = null;
    let _rec3dRaf = 0, _rec3dStream = null;

    const _defer = (fn) =>
        (window.queueMicrotask ? queueMicrotask(fn) : Promise.resolve().then(fn));

    function stopMediaStream(stream) {
        if (!stream) return;
        try { stream.getTracks().forEach(t => t.stop()); }
        catch (e) { console.warn('stopMediaStream:', e); }
    }

    function revokeCurrentVideoObjectURL() {
        if (!_videoObjectUrl) return;
        try {
            // ★ 修正1: src を空にしてデコーダーのバッファを解放してから revoke
            //   src を先に消さないと revoke 後もブラウザが参照を保持し続ける場合がある
            if (video.src === _videoObjectUrl) {
                video.src = '';
                // ★ video.load() は呼ばない（直後に新 URL で上書きされるため）
            }
            URL.revokeObjectURL(_videoObjectUrl);
        }
        catch (e) { console.warn('revokeCurrentVideoObjectURL:', e); }
        _videoObjectUrl = null;
    }

    function disposeDetector() {
        if (!detector) return;
        try { if (typeof detector.close === 'function') detector.close(); }
        catch (e) { console.warn('detector.close() failed:', e); }
        finally { detector = null; }
    }

    function safePauseVideo() {
        try { if (video && !video.paused) video.pause(); }
        catch (e) { console.warn('video.pause() failed:', e); }
    }

    function resetTrackingCaches() {
        state.history = [];
        state.smoothedLandmarks = null;
        state.smoothedWorldLandmarks = null;
        state.lastValidFrame = null;
        state.lastReliableLandmarks = null;
        state.lastWorldLocal = null;
        state.worldOrigin = null;
        state.isEmaResetTriggered = true;
        state.abJumping = false;
        state.isSeekingFrame = false;
        _pendingSeekTime = null;
        _updateMemoryBadge(0);
    }

    function sanitizeLandmarkList(list, withZ = false) {
        if (!Array.isArray(list)) return null;
        const out = new Array(list.length);
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const x = Number(p?.x);
            const y = Number(p?.y);
            const z = Number(p?.z);
            const visibility = Number(p?.visibility);
            if (!Number.isFinite(x) || !Number.isFinite(y) ||
                (withZ && !Number.isFinite(z))) {
                out[i] = null; continue;
            }
            out[i] = withZ
                ? { x, y, z, visibility: Number.isFinite(visibility) ? visibility : 1 }
                : { x, y,    visibility: Number.isFinite(visibility) ? visibility : 1 };
        }
        return out;
    }

    function stopRenderLoop() {
        state.loopRunning = false;
        if (_renderLoopRaf) { cancelAnimationFrame(_renderLoopRaf); _renderLoopRaf = 0; }
    }

    // ★ Safari対応: サポートされている録画MIMEタイプを自動選択（優先順位順）
    // ★ 修正1(QuickTime対応): 無音のダミー AudioTrack を生成して MediaStream に追加する
    //   captureStream() は映像のみ → AudioTrack なしの MP4 を QuickTime が破損ファイル扱いする問題を回避
    function _createSilentAudioTrack() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
            const dst = ctx.createMediaStreamDestination();
            // 無音 OscillatorNode を接続（フレームを流し続けるが振幅 0）
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0;          // 完全無音
            osc.connect(gain);
            gain.connect(dst);
            osc.start();
            const track = dst.stream.getAudioTracks()[0];
            // 録画停止時に AudioContext も閉じるためインスタンスを返す
            return { track, audioCtx: ctx };
        } catch (e) {
            console.warn('[KS] silent audio track creation failed (non-fatal):', e);
            return null;
        }
    }

    function _getBestRecordingMimeType() {
        // ★ 修正①: VP9→VP8→WebM→MP4(avc1.42E01E)→MP4 の優先順でサポート確認
        //   avc1.42E01E は Safari が最も広くサポートする H.264 プロファイル
        const candidates = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
            'video/mp4;codecs=avc1.42E01E', // Safari (iOS/Mac) 向け H.264 Baseline
            'video/mp4;codecs=avc1',
            'video/mp4',
        ];
        for (const mime of candidates) {
            if (MediaRecorder.isTypeSupported(mime)) return mime;
        }
        return ''; // どれも非対応 → ブラウザのデフォルトに委ねる
    }

    function installLifecycleGuards() {
        if (installLifecycleGuards._done) return;
        installLifecycleGuards._done = true;

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                _resumeAfterVisible = (typeof video !== 'undefined') && !!video && !video.paused && !video.ended;
                // ★ 修正: _rec2dRunning / _rec3dRunning は后ろで let 宣言されるため typeof ガード
                if (typeof _rec2dRunning !== 'undefined' && _rec2dRunning) stopRecording2D();
                if (typeof _rec3dRunning !== 'undefined' && _rec3dRunning) stopRecording3D();
                // ★ 修正2: バックグラウンドでは必ず動画停止 + ループ停止
                //   video は rAF が止まってもオーディオタイマーで再生継続するため
                //   currentTime が history の範囲を超えてクラッシュする原因になる
                safePauseVideo();
                stopRenderLoop();
            } else {
                state.needsRender3D = true;
                // ★ 修正2: 復帰時に pending シーク・ロックをリセットしてから再開
                //   バックグラウンド中に seeked が未発火のまま残っていた場合の保護
                state.isSeekingFrame = false;
                _pendingSeekTime = null;
                ++_seekToken; // 古いトークンを無効化

                if (_resumeAfterVisible && video?.readyState >= 2) {
                    video.play().catch(err => {
                        if (err.name !== 'AbortError') console.warn('resume after visible:', err);
                    });
                    startRenderLoop();
                }
                _resumeAfterVisible = false;
            }
        });

        window.addEventListener('pagehide', () => {
            stopRenderLoop();
            if (typeof _rec2dRunning !== 'undefined' && _rec2dRunning) stopRecording2D();
            if (typeof _rec3dRunning !== 'undefined' && _rec3dRunning) stopRecording3D();
            stopMediaStream(_rec2dStream); _rec2dStream = null;
            stopMediaStream(_rec3dStream); _rec3dStream = null;
            revokeCurrentVideoObjectURL();
            disposeDetector();
        }, { passive: true });
    }

    /* ============================================================
       v14.3: 離脱防止アラート（解析データ保護）
    ============================================================ */
    window.addEventListener('beforeunload', (e) => {
        if (state.history && state.history.length > 0) {
            e.preventDefault();
            e.returnValue = ''; // Chrome / Edge 要件
        }
    });


    function getCache(t) {
        const hist = state.history;
        if (!hist || hist.length < 2) return null;

        // --- 1) dt を直近数フレームの平均で推定（安定化） ---
        const sampleN = Math.min(5, hist.length - 1);
        let sumDt = 0;
        for (let i = 0; i < sampleN; i++) {
            sumDt += Math.abs(hist[i + 1].t - hist[i].t);
        }
        const dt = sumDt / sampleN;

        // --- 2) tolerance を厳しめに設定（推奨: dt * 0.35） ---
        const tolerance = dt * 0.35;

        // --- 3) 強制更新保険: 最後に pose.send が走ってからの経過が長ければキャッシュ無効化 ---
        // 0.1 秒以上 pose.send が走っていない場合はキャッシュを無効化して新規解析を促す
        if (typeof lastPoseSendTime === 'number' && (t - lastPoseSendTime) > 0.1) {
            return null;
        }

        // --- 4) 二分探索（hist は時間昇順であることが前提） ---
        let left = 0;
        let right = hist.length - 1;
        while (left <= right) {
            const mid = (left + right) >> 1;
            const midT = hist[mid].t;
            if (midT === t) {
            // 完全一致
            return hist[mid];
            } else if (midT < t) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        // left は挿入位置（最初の midT > t の index）になっている可能性がある
        // 候補を安全に取得（clamp）
        const i1 = Math.min(left, hist.length - 1);
        const i2 = Math.max(left - 1, 0);

        const cand1 = hist[i1];
        const cand2 = hist[i2];

        // --- 5) 最良候補を選ぶ ---
        let best = null;
        if (cand1 && cand2) {
            best = (Math.abs(cand1.t - t) < Math.abs(cand2.t - t)) ? cand1 : cand2;
        } else {
            best = cand1 || cand2 || null;
    }

        // --- 6) 許容誤差内なら返す ---
        if (best && Math.abs(best.t - t) < tolerance) {
            return best;
        }
        return null;
        }

    

    const GRAPH_COLORS = ["#ff4444", "#44ff44", "#4444ff"];
    const COLORS = { L: "#ff7b72", R: "#58a6ff", C: "#ffffff" };

    function getCacheWithDiag(t) {
        DIAG.frames++;
        const res = getCache(t);
        if (res) DIAG.cacheHits++;

        if (DIAG.frames % 60 === 0) {
            console.info(`[DIAG] frames=${DIAG.frames} cacheHits=${DIAG.cacheHits} poseSends=${DIAG.poseSends}`);
        }
        return res;
    }


    /* ============================================================
       2. Joint Definitions
    ============================================================ */
    const POSE_CONNECTIONS = [
        {p:[11,12], side:'C'}, {p:[11,13], side:'L'}, {p:[13,15], side:'L'},
        {p:[12,14], side:'R'}, {p:[14,16], side:'R'}, {p:[11,23], side:'L'},
        {p:[12,24], side:'R'}, {p:[23,24], side:'C'}, {p:[23,25], side:'L'},
        {p:[24,26], side:'R'}, {p:[25,27], side:'L'}, {p:[26,28], side:'R'}
    ];

    const jointGroups = [
        { title: "上肢 (Upper Body)", pairs: [
            { l: {id: 'shoulder_l', name: "左肩", pts: [13, 11, 23]}, r: {id: 'shoulder_r', name: "右肩", pts: [14, 12, 24]} },
            { l: {id: 'elbow_l', name: "左肘", pts: [11, 13, 15]}, r: {id: 'elbow_r', name: "右肘", pts: [12, 14, 16]} },
            { l: {id: 'wrist_l', name: "左手首", pts: [13, 15, 17]}, r: {id: 'wrist_r', name: "右手首", pts: [14, 16, 18]} }
        ]},
        { title: "下肢 (Lower Body)", pairs: [
            { l: {id: 'hip_l', name: "左股関節", pts: [11, 23, 25]}, r: {id: 'hip_r', name: "右股関節", pts: [12, 24, 26]} },
            { l: {id: 'knee_l', name: "左膝", pts: [23, 25, 27]}, r: {id: 'knee_r', name: "右膝", pts: [24, 26, 28]} },
            { l: {id: 'ankle_l', name: "左足首", pts: [25, 27, 31]}, r: {id: 'ankle_r', name: "右足首", pts: [26, 28, 32]} }
        ]},
        { title: "頭・体幹 (Core)", pairs: [
            { l: {id: 'neck', name: "首(推)", pts: [0, 11, 12]}, r: {id: 'spine', name: "背骨", pts: [0, 11, 23]} }
        ]}
    ];

    const allJoints = jointGroups.flatMap(g => g.pairs.flatMap(p => [p.l, p.r]));

    /* --- Landmark index helpers (MediaPipe 33-point model) --- */
    const LEFT  = [1,2,3,7,9,11,13,15,17,19,21,23,25,27,29,31];
    const RIGHT = [4,5,6,8,10,12,14,16,18,20,22,24,26,28,30,32];

    // landmark index → joint id (pts[1] が頂点の関節を優先)
    const indexToJointId = {};
    allJoints.forEach(j => { indexToJointId[j.pts[1]] = j.id; });

    // Three.js 用数値カラー
    const GRAPH_COLORS_HEX = [0xff4444, 0x44ff44, 0x4444ff];

    /* ============================================================
       3. UI: Accordion & Joint Cells
    ============================================================ */
    function initAccordion() {
        const container = document.getElementById('joint-accordion');
        container.innerHTML = '';
        jointGroups.forEach((group, index) => {
            const isFirst = index === 0; // ★ v15i: 最初のグループだけ初期展開
            const item = document.createElement('div');
            item.className = 'accordion-item';
            item.innerHTML = `
                <div class="accordion-header" onclick="toggleAccordion(this)">
                    ${group.title} <i class="fas fa-chevron-down ${isFirst ? 'open' : ''}"></i>
                </div>
                <div class="accordion-content" style="display:${isFirst ? 'block' : 'none'};">
                    ${group.pairs.map(pair => `
                        <div class="joint-row">
                            ${renderCell(pair.l, 'l-side')}
                            ${renderCell(pair.r, 'r-side')}
                        </div>
                    `).join('')}
                </div>
            `;
            container.appendChild(item);
        });
    }

    function renderCell(joint, sideClass) {
        if(!joint) return '<div></div>';
        state.visibleJoints.add(joint.id);

        return `
            <div class="joint-cell ${sideClass}" id="cell-${joint.id}"
                 onmouseenter="handleFocus('${joint.id}')"
                 onmouseleave="handleBlur()"
                 ontouchstart="handleFocus('${joint.id}')"
                 ontouchend="handleBlur()"
                 ontouchcancel="handleBlur()">
                <div class="joint-cell-header">
                    <i class="fas fa-eye btn-toggle" id="tog-${joint.id}"
                       onclick="toggleJoint('${joint.id}')" title="ドット強調 + グラフ表示"></i>
                    <span style="font-weight:bold;">${joint.name}</span>
                    <i class="fas fa-route btn-spot" id="trail-${joint.id}"
                       onclick="trailJoint('${joint.id}')" title="軌道を描く"></i>
                </div>
                <div class="joint-cell-val" id="val-${joint.id}">--.-°</div>
            </div>
        `;
    }

    /* ============================================================
       3b. Mobile Angle Overlay (v15i-mobile)
       モバイル用：2Dビュー上に角度を直接オーバーレイ表示
    ============================================================ */
    function initMobileOverlay() {
        const overlay = document.getElementById('mobile-angle-overlay');
        if (!overlay) return;
        overlay.innerHTML = '';
        jointGroups.forEach(group => {
            group.pairs.forEach(pair => {
                const row = document.createElement('div');
                row.className = 'mob-angle-row';
                [pair.l, pair.r].forEach(joint => {
                    if (!joint) return;
                    const side = joint.id.endsWith('_l') || joint.id === 'neck' ? 'l-side' : 'r-side';
                    const cell = document.createElement('div');
                    cell.className = `mob-angle-cell ${side}`;
                    cell.id = `mob-cell-${joint.id}`;
                    cell.innerHTML = `
                        <span class="mob-angle-name">${joint.name}</span>
                        <span class="mob-angle-val" id="mob-val-${joint.id}">--.-°</span>
                    `;
                    row.appendChild(cell);
                });
                overlay.appendChild(row);
            });
        });

        // トグルボタンの開閉処理
        const toggle = document.getElementById('mob-overlay-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const expanded = overlay.classList.toggle('expanded');
                toggle.classList.toggle('active', expanded);
            });
            toggle.addEventListener('touchend', e => {
                e.preventDefault(); // タップ選択レイヤーへの伝播を防ぐ
                const expanded = overlay.classList.toggle('expanded');
                toggle.classList.toggle('active', expanded);
            }, { passive: false });
        }
    }

    function updateMobileOverlay(angles) {
        allJoints.forEach(j => {
            const el = document.getElementById(`mob-val-${j.id}`);
            if (!el) return;
            const angle = angles[j.id];
            el.textContent = angle !== null && angle !== undefined ? `${angle.toFixed(1)}°` : '--.-°';

            // グラフ選択中の関節はハイライト
            const cell = document.getElementById(`mob-cell-${j.id}`);
            if (cell) {
                if (state.graphJoints.includes(j.id)) {
                    cell.classList.add('active-graph');
                } else {
                    cell.classList.remove('active-graph');
                }
            }
        });
    }

    /* ============================================================
       3c. Tap-to-Select Joint (v15i-tap)
       2Dキャンバス上のタップ/クリックで最も近い関節を自動選択
    ============================================================ */
    function initTapSelect() {
        const layer = document.getElementById('tap-select-layer');
        if (!layer) return;

        // --- letterbox補正: object-fit:contain のオフセット/スケールを計算 ---
        function getVideoRenderRect() {
            const canvas = document.getElementById('canvas-2d');
            if (!canvas || !video.videoWidth || !video.videoHeight) return null;

            // canvas の表示サイズ（CSS px）
            const dispW = canvas.clientWidth;
            const dispH = canvas.clientHeight;
            const vidW  = video.videoWidth;
            const vidH  = video.videoHeight;

            // object-fit:contain と同じ計算
            const scale = Math.min(dispW / vidW, dispH / vidH);
            const renderW = vidW * scale;
            const renderH = vidH * scale;
            const offsetX = (dispW - renderW) / 2;
            const offsetY = (dispH - renderH) / 2;

            return { offsetX, offsetY, renderW, renderH, scale };
        }

        // --- タップ座標 → ランドマーク正規化座標 (0〜1) に変換 ---
        function clientToNorm(clientX, clientY) {
            const rect = layer.getBoundingClientRect();
            const localX = clientX - rect.left;
            const localY = clientY - rect.top;

            const vr = getVideoRenderRect();
            if (!vr) return null;

            const normX = (localX - vr.offsetX) / vr.renderW;
            const normY = (localY - vr.offsetY) / vr.renderH;

            // 映像エリア外タップは無視
            if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return null;
            return { x: normX, y: normY };
        }

        // --- 最近傍関節を探す ---
        // allJoints の pts[1]（頂点ランドマーク）と比較
        // 選択可能半径: 表示ピクセルで 60px（タップ精度を考慮した大きめの当たり判定）
        const HIT_RADIUS_NORM = 0.12; // 正規化座標での許容距離

        function findNearestJoint(normX, normY) {
            const lm = state.lastValidFrame?.l;
            if (!lm) return null;

            let best = null;
            let bestDist = HIT_RADIUS_NORM;

            allJoints.forEach(j => {
                const pt = lm[j.pts[1]];
                if (!pt) return;
                const dx = pt.x - normX;
                const dy = pt.y - normY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = j;
                }
            });
            return best;
        }

        // --- リップルフィードバック ---
        function showRipple(clientX, clientY) {
            const rect = layer.getBoundingClientRect();
            const ripple = document.createElement('div');
            ripple.className = 'tap-ripple';
            ripple.style.left = (clientX - rect.left) + 'px';
            ripple.style.top  = (clientY - rect.top)  + 'px';
            layer.appendChild(ripple);
            ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
        }

        // --- 初回ヒントの表示 ---
        let _hintTimer = null;
        let _hintShown = false;
        function showHint() {
            if (_hintShown) return;
            const hint = document.getElementById('tap-hint');
            if (!hint) return;
            hint.classList.add('show');
            clearTimeout(_hintTimer);
            _hintTimer = setTimeout(() => {
                hint.classList.remove('show');
                _hintShown = true;
            }, 2500);
        }

        // --- タップ処理本体 ---
        function handleTap(clientX, clientY) {
            const norm = clientToNorm(clientX, clientY);
            if (!norm) return;

            showRipple(clientX, clientY);

            const joint = findNearestJoint(norm.x, norm.y);
            if (joint) {
                toggleJoint(joint.id);   // サイドバーの目ボタンと同じアクション

                // ★ v15i-tap: 選択確定フラッシュをトリガー
                state.tapFlash = { jointId: joint.id, startTime: performance.now() };

                refreshJointUI();

                // 一時停止中はループが動いていないため、フラッシュ期間だけ再描画を繰り返す
                if (video.paused) {
                    const FLASH_DURATION = 300;
                    const flashStart = state.tapFlash.startTime;
                    const flashLoop = () => {
                        if (!state.tapFlash) return; // 既にクリア済み
                        const elapsed = performance.now() - flashStart;
                        const f = state.lastValidFrame;
                        if (f) { draw2D(f.l, f.a); }
                        if (elapsed < FLASH_DURATION) requestAnimationFrame(flashLoop);
                    };
                    requestAnimationFrame(flashLoop);
                }
            } // end if(joint)
        }

        // --- イベント登録 ---
        // タッチ: touchend で処理（touchstart だとスクロールと競合しないよう）
        let _touchMoved = false;
        layer.addEventListener('touchstart', () => { _touchMoved = false; }, { passive: true });
        layer.addEventListener('touchmove',  () => { _touchMoved = true;  }, { passive: true });
        layer.addEventListener('touchend', e => {
            if (_touchMoved) return; // スクロール誤爆を防止
            const t = e.changedTouches[0];
            if (t) handleTap(t.clientX, t.clientY);
        }, { passive: true });

        // マウス（デスクトップ確認用）
        layer.addEventListener('click', e => {
            handleTap(e.clientX, e.clientY);
        });

        // 動画読み込み後に初回ヒントを表示
        video.addEventListener('loadeddata', () => {
            setTimeout(showHint, 800);
        }, { once: false });
    }

    /* ============================================================
       3d. Status Pills + Scroll Fade (v15i-status)
    ============================================================ */
    function updateStatusPills() {
        // LOOP ピル: A/B 両方セット済みのとき
        const pillLoop = document.getElementById('pill-loop');
        if (pillLoop) {
            pillLoop.classList.toggle('active',
                state.repeatA !== null && state.repeatB !== null);
        }

        // REC ピル: 2D or 3D 録画中
        const pillRec = document.getElementById('pill-rec');
        if (pillRec) {
            const recActive =
                (typeof _rec2dRunning !== 'undefined' && _rec2dRunning) ||
                (typeof _rec3dRunning !== 'undefined' && _rec3dRunning);
            pillRec.classList.toggle('active', recActive);
        }

        // 3D RELATIVE ピル: 相対座標モード ON のとき
        const pill3d = document.getElementById('pill-3drel');
        if (pill3d) {
            pill3d.classList.toggle('active', !!state.relativeOriginMode);
        }

        // GRAPH ピル: 1つ以上グラフ選択中
        const pillGraph = document.getElementById('pill-graph');
        const pillGraphCount = document.getElementById('pill-graph-count');
        if (pillGraph) {
            const n = state.graphJoints.length;
            pillGraph.classList.toggle('active', n > 0);
            if (pillGraphCount) pillGraphCount.textContent = n;
        }
    }

    // コントロールボタン列の横スクロール可否を検出してフェードを表示
    function updateScrollFade() {
        const wrap = document.getElementById('control-buttons-wrap');
        const inner = wrap?.querySelector('.control-buttons');
        if (!wrap || !inner) return;
        const canScroll = inner.scrollWidth > inner.clientWidth + 4;
        wrap.classList.toggle('can-scroll', canScroll);
    }

    function toggleAccordion(header) {
        const content = header.nextElementSibling;
        const icon = header.querySelector('i');

        const isOpen = content.style.display === 'block';

        if (isOpen) {
            content.style.display = 'none';
            if (icon) icon.classList.remove('open');
        } else {
            content.style.display = 'block';
            if (icon) icon.classList.add('open');
        }
    }

/* ============================================================
    4. Joint Hover / Toggle / Spot  (v12.2 完全同期版)
    ============================================================ */
    function handleFocus(id) {
        state.hoverJoint = id;
        document.querySelectorAll('.joint-cell').forEach(el => {
            if (el.id !== `cell-${id}`) el.classList.add('dimmed');
            else el.classList.add('hover-focus');
        });
        // ★ v14.2d: ホバー変化でキャンバスを再描画（念のため）
        requestRepaint();
    }

    function handleBlur() {
        state.hoverJoint = null;
        document.querySelectorAll('.joint-cell').forEach(el => {
            el.classList.remove('dimmed', 'hover-focus');
        });
        // ★ v14.2d: ホバー解除時に即再描画してキャンバス残像を消す
        requestRepaint();
    }

    /* ------------------------------------------------------------
    グラフ用トグル（最大3つ）
    ------------------------------------------------------------ */
    function toggleJoint(id) {
        const index = state.graphJoints.indexOf(id);

        if (index > -1) {
            state.graphJoints.splice(index, 1);
        } else {
            if (state.graphJoints.length >= 3) state.graphJoints.shift();
            state.graphJoints.push(id);
        }

        refreshJointUI();
        requestRepaint(); // ★ v14.2: 一時停止中もグラフ・ドット色変化を即時反映
    }

    /* ------------------------------------------------------------
    SPOT（目マーク）— v12.2 仕様：joint ではなく landmark index を保持
    ★ 修正: 現状 HTML からは使われていないが、JS API として保持（window に expose）
    ------------------------------------------------------------ */
    function spotJoint(id) {
        const jointDef = allJoints.find(j => j.id === id);
        if (!jointDef) return;

        const idx = jointDef.pts[1];   // ★ 1 点だけ spot にする

        state.activeSpotIndex = (state.activeSpotIndex === idx) ? null : idx;

        refreshJointUI();
        // ★ v14.1 fix: 一時停止中もキャンバスを即時再描画
        _redrawIfPaused();
    }
    // ★ 修正: HTML inline onclick やコンソールから呼べるよう window に expose
    window.spotJoint = spotJoint;

    /* ------------------------------------------------------------
    UI 更新（graph / spot の見た目を同期）
    ------------------------------------------------------------ */
    function refreshJointUI() {
        allJoints.forEach(j => {
            const togEl   = document.getElementById(`tog-${j.id}`);
            const trailEl = document.getElementById(`trail-${j.id}`);
            const cellEl  = document.getElementById(`cell-${j.id}`);
            if (!togEl || !cellEl) return;

            /* --- グラフバッジのリセット --- */
            const existingBadge = cellEl.querySelector('.graph-badge');
            if (existingBadge) existingBadge.remove();

            /* --- 目ボタン：graphJoints に入っているかどうか --- */
            const gIdx = state.graphJoints.indexOf(j.id);
            if (gIdx > -1) {
                const activeColor = GRAPH_COLORS[gIdx];
                togEl.classList.add('active');
                togEl.style.color = activeColor;

                const badge = document.createElement('span');
                badge.className = 'graph-badge';
                badge.style.backgroundColor = activeColor;
                badge.innerText = gIdx + 1;
                togEl.parentNode.insertBefore(badge, togEl.nextSibling);
            } else {
                togEl.classList.remove('active');
                togEl.style.color = '';
            }

            /* --- 軌道ボタン：activeTrailIndex で判定 --- */
            if (trailEl) {
                if (state.activeTrailIndex === j.pts[1]) {
                    trailEl.classList.add('active');
                } else {
                    trailEl.classList.remove('active');
                }
            }
        });

        // モバイルオーバーレイのグラフハイライトを同期
        const lastAngles = state.lastValidFrame?.a;
        if (lastAngles) updateMobileOverlay(lastAngles);

        // ステータスピルを同期（グラフ選択数が変わった）
        updateStatusPills();
    }
    /* ★ v14.1 fix: 一時停止中に目/軌道ボタンを押したときの即時再描画
       lastValidFrame がなければ（まだ解析していない）何もしない         */
    /* ★ v14.2: requestRepaint — 一時停止中の全UI操作に共通する強制再描画
       ・トレーリングデバウンス 16ms（最後の呼び出しから 1f 後に描画）
       ・clearTimeout でタイマーをリセットするため、連打しても必ず最後の状態を反映する
       ・3D レンダリングも含む完全版
    ------------------------------------------------------------ */
    let _repaintTimer = null;
    function requestRepaint() {
        if (!video || !video.paused) return;   // 再生中はループ側が描く
        if (_repaintTimer) clearTimeout(_repaintTimer); // ★ 前のタイマーをキャンセルして再スケジュール
        _repaintTimer = setTimeout(() => {
            _repaintTimer = null;
            const f = state.lastValidFrame;
            if (!f) return;
            draw2D(f.l, f.a);
            update2DTrail();
            if (f.w && f.w.length > 0) {
                draw3D(f.w);
                update3DTrail(f.w);
                if (renderer && scene && camera) renderer.render(scene, camera);
            }
            drawGraph();
            // モバイルオーバーレイも同期更新（一時停止中シーク時）
            if (f.a) updateMobileOverlay(f.a);
        }, 16);  // ★ 16ms = 1フレーム相当。即時に近い応答感を確保
    }
    // 後方互換エイリアス（内部から直接呼ぶ箇所用）
    const _redrawIfPaused = requestRepaint;

    /* ------------------------------------------------------------
    軌道ボタン：activeTrailIndex を ON/OFF
    draw2DTrail / update3DTrail がこの index を参照する
    ------------------------------------------------------------ */
    function trailJoint(id) {
        const jointDef = allJoints.find(j => j.id === id);
        if (!jointDef) return;
        const idx = jointDef.pts[1];
        state.activeTrailIndex = (state.activeTrailIndex === idx) ? null : idx;
        refreshJointUI();
        // ★ v14.1 fix: 一時停止中もキャンバスを即時再描画
        _redrawIfPaused();
    }

    /* ------------------------------------------------------------
    UI 更新（graph バッジ / trail ボタン active を同期）
    ------------------------------------------------------------ */
    function toggleSettings() {
        document.getElementById('settings-drawer').classList.toggle('open');
    }

    /* ============================================================
       isLandmarkVisible — hiddenLandmarks フィルタ
       未定義のまま draw3D から呼ばれていたため毎フレームクラッシュ → 修正
    ============================================================ */
    function isLandmarkVisible(i) {
        return !(state.hiddenLandmarks && state.hiddenLandmarks[i]);
    }

    /* ============================================================
       6. Tracking Mode Toggle //完全削除
    ============================================================ */

    /* ============================================================
    7. Three.js Initialization
    ============================================================ */
    let scene, camera, renderer, controls;

    const objGroup = new THREE.Group();
    objGroup.points = new THREE.Group();
    objGroup.lines = new THREE.Group();
    objGroup.dots = new THREE.Group();
    objGroup.trail = new THREE.Group();

    objGroup.add(objGroup.points);
    objGroup.add(objGroup.lines);
    objGroup.add(objGroup.dots);
    objGroup.add(objGroup.trail);

    /* ★ Trail シングルトン — 毎フレーム new/dispose せず使い回す
       GCの発生を排除してカクつきを防ぐ。                          */
    const _TRAIL_MAX_PTS  = 300; // CatmullRom展開後の最大頂点数（余裕を持たせる）
    const _trailPositions = new Float32Array(_TRAIL_MAX_PTS * 3);
    const _trailGeo = new THREE.BufferGeometry();
    _trailGeo.setAttribute('position',
        new THREE.BufferAttribute(_trailPositions, 3));
    _trailGeo.setDrawRange(0, 0); // 初期は描画なし
    const _trailMat = new THREE.LineBasicMaterial({
        color: 0xffd27f, transparent: true, opacity: 0.45
    });
    const _trailLine = new THREE.Line(_trailGeo, _trailMat);
    objGroup.trail.add(_trailLine); // 一度だけ追加、以後は属性更新のみ

    /* ★ v14.1: Trail Vector3 プール — new THREE.Vector3() を毎フレーム呼ばない */
    const _trailV3Pool = Array.from({ length: _TRAIL_MAX_PTS }, () => new THREE.Vector3());

    // ★★★ これが無いと 3D が後ろ向きになる ★★★
    objGroup.scale.z = -1;

    function initThree() {
        const container = document.getElementById('three-container');

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(
            45,
            container.clientWidth / container.clientHeight,
            0.1,
            1000
        );

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Retina対応（上限2で負荷抑制）
        renderer.setClearColor(0x000000, 0);
        container.appendChild(renderer.domElement);

        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enablePan     = true;   // ★ Ctrl+ドラッグでパン可
        controls.enableDamping = false;  // ★ 余韻なし・即時停止
        camera.position.set(0, 1.2, 3.5);

        /* -------------------------------
        Grid (床面)
        --------------------------------*/
        const grid = new THREE.GridHelper(10, 20, 0x333333, 0x111111);
        grid.position.y = 0; // ★ 床面を固定
        scene.add(grid);

        /* -------------------------------
        Axes Helper
        --------------------------------*/
        const axes = new THREE.AxesHelper(0.5);
        axes.position.y = 0;
        scene.add(axes);

        /* -------------------------------
        Light
        --------------------------------*/
        scene.add(new THREE.AmbientLight(0xffffff, 1.0));

        /* -------------------------------
        Object Group
        --------------------------------*/
        scene.add(objGroup);

        /* -------------------------------
        Resize Handling
        --------------------------------*/
        window.addEventListener('resize', () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        });

        /* -------------------------------
        WebGL コンテキスト消失対応 (Bug-S fix)
        iOS Safari がバックグラウンド時にGPUメモリを破棄した場合の安全策
        --------------------------------*/
        renderer.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); // ブラウザのデフォルト処理（canvas消去）を防ぐ
            console.warn('[KS] WebGL context lost');
            // データを守るためまず未保存バッジを表示
            _showUnsavedBadge(true);
            alert(
                '端末のメモリ不足により3D描画が停止しました。\n' +
                '解析データはサイドバーに保持されています。\n' +
                '「データ → セッション保存」でデータを保存後、\n' +
                'ページを再読み込みしてください。'
            );
        }, false);

        renderer.domElement.addEventListener('webglcontextrestored', () => {
            // コンテキストが復帰した場合（まれ）は強制再描画
            console.info('[KS] WebGL context restored');
            state.needsRender3D = true;
        }, false);
    }

    /* ============================================================
       8. Camera Presets
    ============================================================ */
    function setCamera(type) {
        if (!camera || !controls) return;

        // 1. カメラ位置の変更
        switch(type) {
            case 'front': camera.position.set(0, 1.2, 4); break;
            case 'side':  camera.position.set(4, 1.2, 0); break;
            case 'top':   camera.position.set(0, 5, 0.1); break;
            case 'reset': camera.position.set(2, 2, 4); break;
        }
        
        // 2. コントロールの更新（lookAtなどを反映）
        controls.update();

        // 3. ★決定打：一時停止中でも「今すぐ」3Dを描き直す
        const f = state.lastValidFrame;
        if (f && f.w && typeof draw3D === 'function') {
            draw3D(f.w);
            if (typeof update3DTrail === 'function') update3DTrail(f.w, f.t);
            renderer.render(scene, camera);
        }
    }

    /* ============================================================
       v14: ローダー進捗ヘルパー
    ============================================================ */
    function setLoaderProgress(msg, sub, pct) {
        const t = document.getElementById('loader-text');
        const s = document.getElementById('loader-sub');
        const b = document.getElementById('loader-bar');
        if (t) t.innerText = msg;
        if (s) s.innerText = sub || '';
        if (b) b.style.width = (pct ?? 0) + '%';
    }

    async function initMediaPipe(retryCount = 0) {
        // ★ 修正2: 初期化中の多重呼び出しをブロック（WASMゾンビ防止）
        if (_isMediaPipeInitializing) {
            console.warn('[KS] initMediaPipe: already initializing, skipped');
            return;
        }
        _isMediaPipeInitializing = true;

        const MAX_RETRY = 3;
        const loader = document.getElementById('loader');

        /* ★ v14.1: 10秒タイムアウト → フェイルセーフUI */
        let _timeoutId = null;
        const _startTimeout = () => {
            _timeoutId = setTimeout(() => {
                setLoaderProgress(
                    '⏱ 読み込みがタイムアウトしました',
                    'ネットワーク接続を確認し、ページをリロードしてください', 0
                );
                // リロードボタンを追加
                const bar = document.getElementById('loader-bar-wrap');
                if (bar && !document.getElementById('loader-reload-btn')) {
                    const btn = document.createElement('button');
                    btn.id = 'loader-reload-btn';
                    btn.textContent = 'ページをリロード';
                    btn.style.cssText =
                        'margin-top:12px;padding:6px 18px;background:#238636;' +
                        'color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
                    btn.onclick = () => location.reload();
                    bar.parentNode.insertBefore(btn, bar.nextSibling);
                }
            }, 10000);
        };
        const _clearTimeout = () => { if (_timeoutId) { clearTimeout(_timeoutId); _timeoutId = null; } };

        try {
            _startTimeout();

            setLoaderProgress(
                `AIモデルを初期化中...${retryCount > 0 ? ` (再試行 ${retryCount}/${MAX_RETRY})` : ''}`,
                'MediaPipe モジュールを待機中', 10
            );

            let waitCount = 0;
            while (!window.MPTasks && waitCount++ < 60) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!window.MPTasks) throw new Error('MediaPipe モジュールのロードがタイムアウトしました');

            setLoaderProgress('WASMランタイムを読み込み中...', 'vision tasks wasm', 35);

            const { PoseLandmarker, FilesetResolver } = window.MPTasks;

            const vision = await FilesetResolver.forVisionTasks(
                "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
            );

            setLoaderProgress('ポーズ推定モデルをダウンロード中...', 'このステップに数秒かかる場合があります', 60);

            const complexity = parseInt(document.getElementById('model-complexity-select').value);
            const modelPath =
                complexity === 0
                    ? "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
                    : complexity === 2
                    ? "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task"
                    : "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

            try {
                detector = await PoseLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: modelPath, delegate: "GPU" },
                    runningMode: "VIDEO",
                    numPoses: 1
                });
            } catch (gpuErr) {
                console.warn("GPU 初期化失敗。CPU にフォールバックします:", gpuErr);
                detector = await PoseLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: modelPath, delegate: "CPU" },
                    runningMode: "VIDEO",
                    numPoses: 1
                });
            }

            _clearTimeout(); // 成功時にタイムアウトをキャンセル
            setLoaderProgress('準備完了！', '', 100);
            console.log("MediaPipe Initialized, complexity:", complexity);
            await new Promise(r => setTimeout(r, 300));
            if (loader) loader.style.display = 'none';

        } catch (e) {
            _clearTimeout();
            console.error('initMediaPipe error:', e);
            if (retryCount < MAX_RETRY) {
                setLoaderProgress(
                    `ネットワークエラー。${2}秒後に再試行...`,
                    `(${retryCount+1}/${MAX_RETRY}) ${e.message}`, 0
                );
                // ★ 修正2: リトライ前にフラグを解除してから再帰呼び出し
                _isMediaPipeInitializing = false;
                await new Promise(r => setTimeout(r, 2000));
                return initMediaPipe(retryCount + 1);
            } else {
                setLoaderProgress(
                    '初期化に失敗しました',
                    'ページをリロードしてください: ' + e.message, 0
                );
                _isMediaPipeInitializing = false; // ★ 修正2: 最終失敗時も解除
                throw e;
            }
        } finally {
            // ★ 修正2: 正常完了時は finally でフラグ解除（catch 内でも解除済みだが二重防護）
            _isMediaPipeInitializing = false;
        }
    }

    /* ============================================================
       10. Angle Calculation
    ============================================================ */
    /* calcAngle3D / isReliablePoint / _diffSeries は pose-math.js へ移動 (M-1)
       classic script として index.html で app.js より前に読み込まれるため、
       ここから通常の関数呼び出しとして参照できる。 */

    /* ============================================================
        Local 3D Transform: world → local (hip-centered)  [高速版]
    ============================================================ */
    // v12.3: Origin固定方式
    state.worldOrigin = state.worldOrigin || null;

    function convertWorldToLocal(worldRaw) {
        if (!worldRaw || worldRaw.length < 1) return null;

        const l = worldRaw[23];
        const r = worldRaw[24];
        if (!l || !r) return null;

        // ★ v14.1: 相対座標モードが OFF の場合は原点補正をスキップ
        if (!state.relativeOriginMode) {
            return worldRaw.map(p => p ? { x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 } : null);
        }

        // 初回 or シーク直後だけ Origin を更新（相対座標 ON のみ）
        if (!state.worldOrigin || state.isEmaResetTriggered) {
            state.worldOrigin = {
                x: (l.x + r.x) * 0.5,
                y: (l.y + r.y) * 0.5,
                z: (l.z + r.z) * 0.5
            };
            // ★ Bug-A fix: フラグのリセットは onPoseResults の最後にまとめて行う。
            //   ここでリセットすると smoothWorldLandmarks がリセットされないまま
            //   EMA が続いてしまうため、ここでは落とさない。
            // state.isEmaResetTriggered = false;  ← 削除
        }

        const cx = state.worldOrigin.x;
        const cy = state.worldOrigin.y;
        const cz = state.worldOrigin.z;

        const out = new Array(worldRaw.length);

        for (let i = 0; i < worldRaw.length; i++) {
            const p = worldRaw[i];
            if (!p) { out[i] = null; continue; }

            out[i] = {
                x: p.x - cx,
                y: p.y - cy,
                z: p.z - cz,
                visibility: p.visibility ?? 1
            };
        }

        return out;
    }
        /* ============================================================
            11. onPoseResults  (v12 最適化・3D高速起動・best‑effort 3D)
        ============================================================ */
    function smoothLandmarks(nextLandmarks) {
    const safe = sanitizeLandmarkList(nextLandmarks, false);
    if (!safe) return null;

    if (!state.smoothedLandmarks ||
        state.smoothedLandmarks.length !== safe.length ||
        state.isEmaResetTriggered) {
        state.smoothedLandmarks = safe.map(p => p ? ({ ...p }) : null);
        return state.smoothedLandmarks;
    }

    const a = state.emaAlpha;
    for (let i = 0; i < safe.length; i++) {
        const src2 = safe[i];
        const dst = state.smoothedLandmarks[i];
        if (!src2) { state.smoothedLandmarks[i] = null; continue; }
        if (!dst)  { state.smoothedLandmarks[i] = { ...src2 }; continue; }
        dst.x = src2.x * a + dst.x * (1 - a);
        dst.y = src2.y * a + dst.y * (1 - a);
        dst.visibility = src2.visibility ?? dst.visibility;
    }
    return state.smoothedLandmarks;
}

    function smoothWorldLandmarks(raw) {
        const safe = sanitizeLandmarkList(raw, true);
        if (!safe) return null;

        if (!state.smoothedWorldLandmarks ||
            state.smoothedWorldLandmarks.length !== safe.length ||
            state.isEmaResetTriggered) {
            state.smoothedWorldLandmarks = safe.map(p => p ? ({ ...p }) : null);
            return state.smoothedWorldLandmarks;
        }

        const a = state.emaAlpha;
        for (let i = 0; i < safe.length; i++) {
            const src2 = safe[i];
            const dst = state.smoothedWorldLandmarks[i];
            if (!src2) { state.smoothedWorldLandmarks[i] = null; continue; }
            if (!dst)  { state.smoothedWorldLandmarks[i] = { ...src2 }; continue; }
            dst.x = src2.x * a + dst.x * (1 - a);
            dst.y = src2.y * a + dst.y * (1 - a);
            dst.z = src2.z * a + dst.z * (1 - a);
            dst.visibility = src2.visibility ?? dst.visibility;
        }
        return state.smoothedWorldLandmarks;
    }

    /* _insertHistoryFrame は history.js へ移動 (M-1)。
       シグネチャを (hist, frame) に変更したため、呼び出し側は
       _insertHistoryFrame(state.history, frame) の形で呼ぶ。 */

    async function onPoseResults(result = {}) {
        const lmRaw    = sanitizeLandmarkList(result.landmarks?.[0],      false);
        const worldRaw = sanitizeLandmarkList(result.worldLandmarks?.[0], true);

        if (!lmRaw || !lmRaw.some(Boolean)) return;

        lastPoseSendTime = video.currentTime;
        DIAG.poseSends++;

        const lm = smoothLandmarks(lmRaw);
        if (!lm) return;

        let worldLocal = null;
        if (worldRaw && worldRaw.length > 0) {
            const tmp = convertWorldToLocal(worldRaw);
            if (Array.isArray(tmp)) {
                worldLocal = smoothWorldLandmarks(tmp);
                if (worldLocal) state.lastWorldLocal = worldLocal;
            }
        }

        state.isEmaResetTriggered = false;

        const worldFor3D = worldLocal || state.lastWorldLocal || [];
        const angles = {};
        const prevLm = state.lastReliableLandmarks;

        allJoints.forEach(j => {
            const p1 = lm[j.pts[0]], p2 = lm[j.pts[1]], p3 = lm[j.pts[2]];
            const reliable =
                isReliablePoint(p1, prevLm?.[j.pts[0]]) &&
                isReliablePoint(p2, prevLm?.[j.pts[1]]) &&
                isReliablePoint(p3, prevLm?.[j.pts[2]]);

            let angle = null;
            if (reliable && worldFor3D.length > 0) {
                const w1 = worldFor3D[j.pts[0]], w2 = worldFor3D[j.pts[1]], w3 = worldFor3D[j.pts[2]];
                if (w1 && w2 && w3) {
                    angle = calcAngle3D(w1, w2, w3);
                    if (angle !== null) {
                        if (j.id.includes("elbow") || j.id.includes("knee") || j.id.includes("hip"))
                            angle = Math.abs(180 - angle);
                        if (j.id.includes("ankle"))
                            angle = angle - 90;
                    }
                }
            }
            angles[j.id] = angle;
            const valEl = document.getElementById(`val-${j.id}`);
            if (valEl) valEl.innerText = angle !== null ? `${angle.toFixed(1)}°` : "--.-°";
        });

        // モバイルオーバーレイに角度を反映
        updateMobileOverlay(angles);

        const compactFrame = {
            t: parseFloat((video.currentTime || 0).toFixed(3)),
            l: lm.map(p => p ? ({
                x: parseFloat(p.x.toFixed(4)),
                y: parseFloat(p.y.toFixed(4)),
                visibility: parseFloat((p.visibility ?? 1).toFixed(2))
            }) : null),
            w: worldFor3D.map(p => p ? ({
                x: parseFloat(p.x.toFixed(4)),
                y: parseFloat(p.y.toFixed(4)),
                z: parseFloat(p.z.toFixed(4)),
                visibility: parseFloat((p.visibility ?? 1).toFixed(2))
            }) : null),
            a: angles
        };

        if (video.videoWidth > 0 && !state.abJumping) {
            // ★ Bug-C1 fix: ジャンプ中（トランジエント区間）は記録しない
            //   ソート挿入により非単調自体は防げるが、シーク遷移中の不安定な
            //   フレームを解析データに混入させない意図はここで維持する
            const _wasEmpty = state.history.length === 0;
            _insertHistoryFrame(state.history, compactFrame);
            if (_wasEmpty && state.history.length > 0) {
                _updateFeatureAvailability(); // ★ 入口導線改善④: 初フレーム記録でCSV/ROMを有効化
            }
            if (state.history.length > state.maxHistory) {
                state.history.splice(0, Math.floor(state.maxHistory * 0.1));
                console.info('[v14] history trimmed: oldest 10% removed');
            }
            _updateMemoryBadge(state.history.length / state.maxHistory);
        }

        if (state.abJumping) return;

        draw2D(lm, angles);
        update2DTrail();

        if (worldFor3D.length > 0) {
            draw3D(worldFor3D);
            update3DTrail(worldFor3D);
        }

        drawGraph();
        updateUI();

        state.lastReliableLandmarks = lm.map(p => p ? ({
            x: p.x, y: p.y, visibility: p.visibility
        }) : null);

        state.lastValidFrame = {
            l: lm.map(p => p ? ({ ...p }) : null),
            w: worldFor3D.map(p => p ? ({ ...p }) : null),
            a: { ...angles }
        };
    }
    /* ============================================================
        draw2D (spot joint の 2D 軌跡を canvas-2d に重ね描き)
    ============================================================ */
    function draw2D(lm = [], angles = {}) {
        const canvas = document.getElementById('canvas-2d');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        if (!lm || lm.length === 0 || !video.videoWidth || !video.videoHeight) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const labelsContainer = document.getElementById('angle-labels');
            if (labelsContainer) labelsContainer.innerHTML = '';
            return;
        }

        const targetW = video.videoWidth;
        const targetH = video.videoHeight;
        /* ★ v14.3a: DPR対応 — Retina/iPad Pro で文字が印刷物のようにシャープになる
           上限を 2 に抑えることで 3× スクリーンでの過剰なメモリ使用を防ぐ         */
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const needResize = canvas._w !== targetW || canvas._h !== targetH || canvas._dpr !== dpr;
        if (needResize) {
            canvas._w   = targetW;
            canvas._h   = targetH;
            canvas._dpr = dpr;
            // 物理バッファを DPR 倍に拡大し、transform を論理座標系に揃える
            canvas.width  = Math.round(targetW * dpr);
            canvas.height = Math.round(targetH * dpr);
            ctx.scale(dpr, dpr); // ← canvas.width 代入でリセットされた transform を再適用
        } else {
            ctx.clearRect(0, 0, targetW, targetH); // DPR scale 有効なまま論理座標でクリア
        }

        const prevLm = state.lastReliableLandmarks;

        /* --- 1. Skeleton lines --- */
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        POSE_CONNECTIONS.forEach(conn => {
            const p1 = lm[conn.p[0]];
            const p2 = lm[conn.p[1]];
            if (!p1 || !p2) return;

            if (!isReliablePoint(p1, prevLm?.[conn.p[0]])) return;
            if (!isReliablePoint(p2, prevLm?.[conn.p[1]])) return;

            ctx.strokeStyle =
                conn.side === 'L' ? COLORS.L :
                conn.side === 'R' ? COLORS.R :
                COLORS.C;

            ctx.lineWidth = 3;
            ctx.globalAlpha = state.alphaSkeleton;

            ctx.beginPath();
            ctx.moveTo(p1.x * targetW, p1.y * targetH);
            ctx.lineTo(p2.x * targetW, p2.y * targetH);
            ctx.stroke();
        });
        ctx.restore();

        /* --- 2. Joint dots --- */

        // ★ spot の landmark index（1点だけ）
        const spotIdx = state.activeSpotIndex;

        // ★ v15i-tap: タップフラッシュの進行率（0→1、300ms）
        const FLASH_DURATION = 300;
        const flashNow = performance.now();
        const flashProgress = state.tapFlash
            ? Math.min(1, (flashNow - state.tapFlash.startTime) / FLASH_DURATION)
            : 1;
        if (flashProgress >= 1) state.tapFlash = null; // フラッシュ終了をクリア

        lm.forEach((p, i) => {
            if (!isReliablePoint(p, prevLm?.[i])) return;

            const x = p.x * targetW;
            const y = p.y * targetH;

            // ★ indexToJointId は pts[1] のみマッピング → 頂点1点だけハイライト
            const jointId = indexToJointId[i] ?? null;

            let color =
                LEFT.includes(i)  ? COLORS.L :
                RIGHT.includes(i) ? COLORS.R :
                                    COLORS.C;

            let alpha = 0.35;
            let radius = 5;

            // graph highlight
            if (jointId && state.graphJoints.includes(jointId)) {
                const gIdx = state.graphJoints.indexOf(jointId);
                color = GRAPH_COLORS[gIdx];
                alpha = 1.0;
                radius = 6;
            }

            // SPOT（最優先）
            if (spotIdx !== null && i === spotIdx) {
                color = "#f1e05a";
                alpha = 1.0;
                radius = 7;
            }

            ctx.save();
            ctx.globalAlpha = alpha;

            // ★ v15i-tap: タップ直後フラッシュ — 選択された関節が白くグローする
            if (state.tapFlash && jointId === state.tapFlash.jointId) {
                const glowAlpha  = (1 - flashProgress) * 0.9;
                const glowRadius = radius + 6 + flashProgress * 8; // 広がりながら消える

                if (state.tapFlashUseShadow === null) {
                    // ★ 初回のみ: shadowBlur のレンダリングコストを計測して自動選択
                    //   オフスクリーンcanvas 1px で計測することで本描画に影響を与えない
                    const probe = document.createElement('canvas');
                    probe.width = probe.height = 1;
                    const pCtx = probe.getContext('2d');
                    const t0 = performance.now();
                    for (let _i = 0; _i < 20; _i++) {
                        pCtx.shadowBlur = 16;
                        pCtx.beginPath();
                        pCtx.arc(0.5, 0.5, 4, 0, Math.PI * 2);
                        pCtx.fill();
                    }
                    const cost = performance.now() - t0;
                    // 20回で 2ms 超（= 1回あたり 0.1ms超）なら低スペック端末と判断
                    state.tapFlashUseShadow = cost < 2;
                    console.info(`[KS] tapFlash: shadowBlur cost=${cost.toFixed(2)}ms/20 → ${state.tapFlashUseShadow ? 'HIGH' : 'LITE'} mode`);
                }

                ctx.save();
                ctx.globalAlpha = glowAlpha;

                if (state.tapFlashUseShadow) {
                    // 通常モード: shadowBlur によるグロー
                    ctx.fillStyle   = '#ffffff';
                    ctx.shadowColor = '#ffffff';
                    ctx.shadowBlur  = 16;
                    ctx.beginPath();
                    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    // 軽量モード: shadowBlur なし・二重リングで「光っている感」を演出
                    // 外リング（薄い白）
                    ctx.fillStyle = `rgba(255,255,255,${glowAlpha * 0.4})`;
                    ctx.beginPath();
                    ctx.arc(x, y, glowRadius + 4, 0, Math.PI * 2);
                    ctx.fill();
                    // 内リング（やや濃い白）
                    ctx.fillStyle = `rgba(255,255,255,${glowAlpha * 0.7})`;
                    ctx.beginPath();
                    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
                    ctx.fill();
                }

                ctx.restore();
            }

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });

        /* --- 3. Angle labels --- */
        const labelsContainer = document.getElementById('angle-labels');
        if (labelsContainer) labelsContainer.innerHTML = '';

        ctx.save();

        allJoints.forEach(j => {
            const isGraphActive = state.graphJoints.includes(j.id);
            const isSpotActive  = (state.activeSpotIndex === j.pts[1]);

            // ★ v14.2d: ホバーはキャンバスに一切描画しない
            // サイドバーの dim 効果だけがホバーフィードバック
            // → toggleOFF 直後・マウス離脱後の白残像を根絶
            if (!isGraphActive && !isSpotActive) return;

            const pt = lm[j.pts[1]];
            if (!pt) return;

            if (!isReliablePoint(pt, prevLm?.[j.pts[1]])) return;

            let color    = "#f1e05a";
            let dotAlpha = state.alphaSpot;

            if (isGraphActive) {
                const gIdx = state.graphJoints.indexOf(j.id);
                color    = GRAPH_COLORS[gIdx];
                dotAlpha = state.alphaGraph;
            }

            // 強調ドット（graphActive / spotActive のみ）
            ctx.save();
            ctx.globalAlpha = dotAlpha;
            ctx.fillStyle   = color;
            ctx.beginPath();
            ctx.arc(pt.x * targetW, pt.y * targetH, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            // 角度ラベル（背景付き・globalAlpha は drawTextBlock 内で 1.0 に固定）
            const angleVal = angles[j.id];
            if (angleVal !== null && angleVal !== undefined) {
                drawTextBlock(
                    ctx,
                    `${angleVal.toFixed(1)}°`,
                    pt.x * targetW + 8,
                    pt.y * targetH - 28,
                    {
                        color,
                        bg: 'rgba(0,0,0,0.80)',
                        fontSize: 14,
                        padding: 4,
                        fontFamily: 'monospace'
                    }
                );
            }
        });

        ctx.restore();
    }

    /* ============================================================
        update2DTrail (spot joint の 2D 軌跡を canvas-2d に重ね描き)
    ============================================================ */
    function update2DTrail() {
        const idx = state.activeTrailIndex;  // ★ 軌道ボタンの index を参照
        if (idx === null || idx === undefined) return;

        const canvas = document.getElementById('canvas-2d');
        if (!canvas || !video.videoWidth || !video.videoHeight) return;

        const ctx = canvas.getContext('2d');
        // ★ v14.3a: DPR 対応後は canvas.width が物理ピクセル数になるため
        //   論理座標 (_w/_h) を使う。未設定の場合は videoWidth/Height にフォールバック。
        const W = canvas._w || video.videoWidth;
        const H = canvas._h || video.videoHeight;

        if (!state.history || state.history.length < 2) return;

        const t = video.currentTime;
        let pos = state.history.findIndex(h => h.t > t);
        if (pos === -1) pos = state.history.length;

        const start = Math.max(0, pos - state.trailLength);
        const historySlice = state.history.slice(start, pos);
        if (historySlice.length < 2) return;

        ctx.save();
        ctx.strokeStyle = `rgba(255,210,127,${state.trailOpacity ?? 0.45})`;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();

        let started = false;

        historySlice.forEach((frame, i) => {
            const lm = frame.l;
            if (!lm || !lm[idx]) return;

            const p = lm[idx];
            const prev = i > 0 ? historySlice[i - 1].l?.[idx] : null;

            if (!isReliablePoint(p, prev)) return;

            const x = p.x * W;
            const y = p.y * H;

            if (!started) {
                ctx.moveTo(x, y);
                started = true;
            } else {
                ctx.lineTo(x, y);
            }
        });

        ctx.stroke();
        ctx.restore();
    }

    /* ============================================================
        13. draw3D — v14.1 色別プール版（color.set() コストをゼロ化）
        ランドマークを L / R / C / SPOT / GRAPH の5色に分類し、
        同色のメッシュを専用プールから引き当てることで
        material.color.set() を毎フレーム呼ばなくて済む設計。
    ============================================================ */

    /* --- 色テーブル (hex → プールindex) --- */
    const _COLOR_L     = 0;
    const _COLOR_R     = 1;
    const _COLOR_C     = 2;
    const _COLOR_SPOT  = 3;
    const _COLOR_G0    = 4;
    const _COLOR_G1    = 5;
    const _COLOR_G2    = 6;
    const _COLORS_HEX  = [0xff7b72, 0x58a6ff, 0xffffff, 0xf1e05a,
                           0xff4444, 0x44ff44, 0x4444ff];
    const _LINE_COLS   = { L: _COLOR_L, R: _COLOR_R, C: _COLOR_C };

    /* --- 共有ジオメトリ --- */
    const _dotBaseGeo  = new THREE.SphereGeometry(0.02, 8, 8);

    /* --- Dot Pool per color (33 slots each, 7 colors) --- */
    const _dotPools = _COLORS_HEX.map(hex => {
        const pool = [];
        const mat  = new THREE.MeshBasicMaterial({
            color: hex, transparent: true, opacity: 0.35
        });
        // SPOT / GRAPH は常に opacity 1.0
        if (hex === _COLORS_HEX[_COLOR_SPOT] ||
            [_COLOR_G0,_COLOR_G1,_COLOR_G2].some(ci => _COLORS_HEX[ci] === hex)) {
            mat.opacity = 1.0;
        }
        for (let i = 0; i < 33; i++) {
            const mesh = new THREE.Mesh(_dotBaseGeo, mat);
            mesh.visible = false;
            objGroup.dots.add(mesh);
            pool.push(mesh);
        }
        return pool;
    });

    /* --- Line Pool per color (POSE_CONNECTIONS.length slots each, 3 colors) --- */
    const _linePools = [_COLOR_L, _COLOR_R, _COLOR_C].map(ci => {
        const pool = [];
        const lineMat = new THREE.LineBasicMaterial({
            color: _COLORS_HEX[ci], transparent: true, opacity: 0.9
        });
        for (let k = 0; k < POSE_CONNECTIONS.length; k++) {
            const positions = new Float32Array(6);
            const geo  = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const line = new THREE.Line(geo, lineMat);
            line.visible = false;
            objGroup.lines.add(line);
            pool.push({ line, positions, geo });
        }
        return pool;
    });

    /* --- Pool スロットカウンター（フレームごとにリセット） --- */
    const _dotSlot  = new Int32Array(7);  // 色別の使用済みスロット数
    const _lineSlot = new Int32Array(3);  // 色別の使用済みスロット数

    // ★ m-1 fix（外部レビュー M-5 対応）: clearGroupChildren() は呼び出し箇所ゼロの
    //   デッドコードだったため削除。共有 geometry/material をプールしている現在の
    //   3D描画（_dotPools / _linePools）に対して誤って呼ばれると、プール自体を
    //   dispose してしまい他のフレームの描画が壊れる危険があったため、
    //   「後方互換のために残す」より削除する方が安全と判断した。

    function draw3D(worldLocal) {
        if (!worldLocal || !objGroup) return;

        const scale   = 1.5;
        const lm2d    = state.smoothedLandmarks;
        const spotIdx = state.activeSpotIndex;

        /* --- 全プールのスロットカウンターをリセット --- */
        _dotSlot.fill(0);
        _lineSlot.fill(0);

        /* --- 座標配列を構築 --- */
        const pts = new Array(worldLocal.length).fill(null);
        worldLocal.forEach((lm3d, i) => {
            if (!lm3d) return;
            const vis2d = lm2d?.[i]?.visibility ?? 1;
            const visW  = lm3d.visibility ?? vis2d;
            if (visW < state.visibilityThreshold) return;
            if (!isLandmarkVisible(i)) return;
            pts[i] = { x: lm3d.x * scale, y: -lm3d.y * scale, z: lm3d.z * scale };
        });

        /* --- Skeleton lines — color.set() なし、座標だけ更新 --- */
        POSE_CONNECTIONS.forEach(conn => {
            const p1 = pts[conn.p[0]];
            const p2 = pts[conn.p[1]];
            const ci  = _LINE_COLS[conn.side] ?? _COLOR_C;
            const pool = _linePools[ci];
            const slot = _lineSlot[ci];

            if (!p1 || !p2 || slot >= pool.length) return;

            const entry = pool[slot];
            entry.positions[0] = p1.x; entry.positions[1] = p1.y; entry.positions[2] = p1.z;
            entry.positions[3] = p2.x; entry.positions[4] = p2.y; entry.positions[5] = p2.z;
            entry.geo.attributes.position.needsUpdate = true;
            entry.line.material.opacity = state.lineOpacity3D;
            entry.line.visible = true;
            _lineSlot[ci]++;
        });

        /* 使われなかったラインスロットを非表示 */
        [_COLOR_L, _COLOR_R, _COLOR_C].forEach(ci => {
            const pool = _linePools[ci];
            for (let s = _lineSlot[ci]; s < pool.length; s++) pool[s].line.visible = false;
        });

        /* --- Dots — color.set() なし、プール割り当てのみ --- */
        if (state.showDots) {
            worldLocal.forEach((_, i) => {
                const p = pts[i];
                if (!p) return;

                const jointId = indexToJointId[i] ?? null;

                /* 色カテゴリを決定（最高優先: SPOT → GRAPH → L/R/C） */
                let ci    = LEFT.includes(i) ? _COLOR_L : RIGHT.includes(i) ? _COLOR_R : _COLOR_C;
                let scale3 = state.sphereSize / 0.02;

                if (jointId && state.graphJoints.includes(jointId)) {
                    ci     = _COLOR_G0 + state.graphJoints.indexOf(jointId);
                    scale3 = (state.sphereSize * 1.2) / 0.02;
                }
                if (spotIdx !== null && i === spotIdx) {
                    ci     = _COLOR_SPOT;
                    scale3 = state.sphereSpotSize / 0.02;
                }

                const pool = _dotPools[ci];
                const slot = _dotSlot[ci];
                if (slot >= pool.length) return;

                const mesh = pool[slot];
                mesh.position.set(p.x, p.y, p.z);
                mesh.scale.setScalar(scale3);
                mesh.visible = true;
                _dotSlot[ci]++;
            });
        }

        /* 使われなかったドットスロットを非表示 */
        _dotPools.forEach((pool, ci) => {
            for (let s = _dotSlot[ci]; s < pool.length; s++) pool[s].visible = false;
        });

        state.needsRender3D = true;
    }



    /* ============================================================
        13-2. update3DTrail — v14.1 完全 GCフリー版
        ・new THREE.Vector3() → _trailV3Pool から再利用
        ・CatmullRomCurve3 を廃止 → Float32Array に直書き
        ・毎フレームのヒープ確保ゼロ
    ============================================================ */
    function update3DTrail(worldLocal) {
        const idx = state.activeTrailIndex;

        if (idx === null || idx === undefined) {
            _trailGeo.setDrawRange(0, 0);
            return;
        }
        if (state.history.length < 2) {
            _trailGeo.setDrawRange(0, 0);
            return;
        }

        const t     = video.currentTime;
        let   pos   = _histBinarySearch(state.history, t);
        const start = Math.max(0, pos - state.trailLength);
        const scale = 1.5;

        /* --- プールの Vector3 に座標を書き込む（slice()廃止 → GCフリー） --- */
        // ★ 修正8: history.slice() を毎フレーム呼ぶと長時間再生でGC圧が上がる。
        //   インデックスで直接アクセスしてアロケーションをゼロにする。
        let writeCount = 0;

        for (let i = start; i < pos && writeCount < _TRAIL_MAX_PTS; i++) {
            const frame = state.history[i];
            const w   = frame.w;
            const l2d = frame.l;
            const prevL2d = i > 0 ? state.history[i - 1].l : null; // ★ Bug-2 fix: i > start だと軌跡先端が毎フレーム千切れる

            if (!w || !w[idx] || !l2d || !l2d[idx]) continue;

            const p3d  = w[idx];
            const p2d  = l2d[idx];
            const prev2d = prevL2d ? prevL2d[idx] : null;

            if (!isReliablePoint(p2d, prev2d)) continue;

            // プールのV3を上書き（new不要）
            _trailV3Pool[writeCount].set(p3d.x * scale, -p3d.y * scale, p3d.z * scale);
            writeCount++;
        }

        if (writeCount < 2) {
            _trailGeo.setDrawRange(0, 0);
            state.needsRender3D = true;
            return;
        }

        /* --- CatmullRom 補間を _trailPositions に直書き（アロケなし） --- */
        // 簡易カーブ: 隣接V3間を線形補間で2倍に増やす（アロケゼロ）
        let pi = 0;
        for (let i = 0; i < writeCount - 1 && pi + 6 <= _TRAIL_MAX_PTS * 3; i++) {
            const a = _trailV3Pool[i];
            const b = _trailV3Pool[i + 1];
            _trailPositions[pi++] = a.x;
            _trailPositions[pi++] = a.y;
            _trailPositions[pi++] = a.z;
            // 中点
            _trailPositions[pi++] = (a.x + b.x) * 0.5;
            _trailPositions[pi++] = (a.y + b.y) * 0.5;
            _trailPositions[pi++] = (a.z + b.z) * 0.5;
        }
        // 最終点
        if (pi + 3 <= _TRAIL_MAX_PTS * 3) {
            const last = _trailV3Pool[writeCount - 1];
            _trailPositions[pi++] = last.x;
            _trailPositions[pi++] = last.y;
            _trailPositions[pi++] = last.z;
        }
        const finalCount = Math.floor(pi / 3);

        _trailGeo.attributes.position.needsUpdate = true;
        _trailGeo.setDrawRange(0, finalCount);
        _trailMat.opacity = state.trailOpacity;
        state.needsRender3D = true;
    }




    /* ============================================================
    14. drawGraph  (パフォーマンス改善版)
    - ResizeObserver でサイズキャッシュ → getBoundingClientRect を毎フレーム呼ばない
    - canvas.width/height の代入は実際にサイズが変わった時だけ
    - findIndex (O(n)) → バイナリサーチ (O(log n))
    ============================================================ */
    const _graphCanvas = (() => {
        const el = document.getElementById('graph-overlay');
        let cw = 0, ch = 0;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) {
                cw = Math.round(e.contentRect.width);
                ch = Math.round(e.contentRect.height);
            }
        });
        ro.observe(el);
        return { el, get w() { return cw; }, get h() { return ch; } };
    })();

    /* _histBinarySearch は history.js へ移動済み (M-1)。
       シグネチャは (hist, t)。呼び出し側は _histBinarySearch(state.history, t) の形。 */

    function drawGraph() {
        const canvas = _graphCanvas.el;
        const W = _graphCanvas.w;
        const H = _graphCanvas.h;
        if (!W || !H) return;

        // ★ サイズが変わった時だけ代入（毎フレームのリセットを防ぐ）
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        if (state.graphJoints.length === 0 || state.history.length < 2) {
            _updateGraphLegend(); // 関節0件になったら凡例もクリア
            return;
        }

        // ★ バイナリサーチで現在位置を取得
        const pos = _histBinarySearch(state.history, video.currentTime);
        const graphLength = 100;
        const start = Math.max(0, pos - graphLength);
        const len = pos - start;
        if (len < 2) return;

        const mode = state.graphMode || 'angle';
        if (mode === 'angle') {
            _drawAngleGraph(ctx, W, H, start, pos, len);
        } else {
            _drawDerivativeGraph(ctx, W, H, start, pos, len, mode);
        }
        _updateGraphLegend();

        // 現在時刻のカーソル線
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(W - 1, 0); ctx.lineTo(W - 1, H);
        ctx.stroke();
        ctx.restore();
    }

    /* --- 角度グラフ（従来通り、0〜180° 固定スケール） --- */
    function _drawAngleGraph(ctx, W, H, start, pos, len) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.font = "9px monospace";
        [45, 90, 135].forEach(angle => {
            const y = H - (angle / 180) * (H * 0.8) - (H * 0.1);
            ctx.strokeStyle = "rgba(255,255,255,0.15)";
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,0.3)";
            ctx.fillText(angle + "°", 5, y - 2);
        });
        ctx.restore();

        state.graphJoints.forEach((jointId, gIdx) => {
            ctx.strokeStyle = GRAPH_COLORS[gIdx];
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.beginPath();

            let started = false;
            for (let i = start; i < pos; i++) {
                const frame = state.history[i];
                const angle = frame.a ? frame.a[jointId] : null; // ★ Bug-O fix: .a が undefined の場合ガード
                if (angle == null) continue;

                const x = ((i - start) / (len - 1)) * W;
                const y = H - (angle / 180) * (H * 0.8) - (H * 0.1);

                if (!started) { ctx.moveTo(x, y); started = true; }
                else { ctx.lineTo(x, y); }
            }
            ctx.stroke();
        });
    }

    /* _diffSeries / _MAX_DT_GAP は pose-math.js へ移動 (M-1) */

    function _drawDerivativeGraph(ctx, W, H, start, pos, len, mode) {
        const times = [];
        for (let i = start; i < pos; i++) times.push(state.history[i].t);

        let globalMax = 0;
        const finalSeries = {}; // jointId -> values[]

        state.graphJoints.forEach(jointId => {
            const angleSeries = [];
            for (let i = start; i < pos; i++) {
                const frame = state.history[i];
                angleSeries.push(frame.a ? (frame.a[jointId] ?? null) : null);
            }
            const velocitySeries = _diffSeries(angleSeries, times);
            const series = (mode === 'velocity') ? velocitySeries : _diffSeries(velocitySeries, times);
            finalSeries[jointId] = series;
            series.forEach(v => { if (v != null) globalMax = Math.max(globalMax, Math.abs(v)); });
        });

        // スケール確定（データが無ければ 1 にフォールバックしてゼロ除算を防止）
        const scale = globalMax > 0 ? globalMax * 1.15 : 1;
        const unit = mode === 'velocity' ? '°/s' : '°/s²';

        // ガイドライン：0 を中心に上下対称
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.font = "9px monospace";
        [scale, scale / 2, 0, -scale / 2, -scale].forEach(v => {
            const y = H / 2 - (v / scale) * (H * 0.45);
            ctx.strokeStyle = v === 0 ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.15)";
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,0.3)";
            ctx.fillText(v.toFixed(0) + unit, 5, y - 2);
        });
        ctx.restore();

        state.graphJoints.forEach((jointId, gIdx) => {
            const series = finalSeries[jointId];
            ctx.strokeStyle = GRAPH_COLORS[gIdx];
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.beginPath();

            let started = false;
            for (let k = 0; k < series.length; k++) {
                const v = series[k];
                if (v == null) { started = false; continue; } // 不連続点で線を切る
                const x = (k / (len - 1)) * W;
                const y = H / 2 - (v / scale) * (H * 0.45);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else { ctx.lineTo(x, y); }
            }
            ctx.stroke();
        });
    }

    /* --- 角度／角速度／角加速度 表示切替 --- */
    function setGraphMode(mode) {
        state.graphMode = mode;
        document.querySelectorAll('.graph-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        drawGraph(); // 一時停止中でも即座に反映
    }

    /* --- グラフ凡例: 表示中の関節と色の対応を表示（不要な再描画は避ける） --- */
    let _lastLegendKey = '';
    function _updateGraphLegend() {
        const key = state.graphJoints.join(',');
        if (key === _lastLegendKey) return;
        _lastLegendKey = key;

        const legend = document.getElementById('graph-legend');
        if (!legend) return;

        legend.innerHTML = state.graphJoints.map((jointId, gIdx) => {
            const joint = allJoints.find(j => j.id === jointId);
            const label = joint ? joint.name : jointId;
            return `<span class="graph-legend-item"><span class="graph-legend-dot" style="background:${GRAPH_COLORS[gIdx]}"></span>${label}</span>`;
        }).join('');
    }

    /* ============================================================
    v14: Memory Badge helper
    ============================================================ */
    function _updateMemoryBadge(usage) {
        const badge = document.getElementById('mem-badge');
        const pct   = document.getElementById('mem-pct');
        if (!badge || !pct) return;
        const p = Math.round(usage * 100);
        pct.textContent = p;
        if (usage >= 0.8) {
            badge.classList.add('warn');
        } else {
            badge.classList.remove('warn');
        }
    }

    /* ★ 入口導線改善④: 動画/解析データ未準備時、依存メニュー項目を視覚的に無効化する。
       完全disabledにするとdata-tipのホバー説明まで失われるため、
       CSSの見た目(.disabledクラス)のみで制御し、クリック時のガードは各関数の
       既存alert()に委ねる（従来の挙動を壊さない）。無効時はツールチップ文言を
       理由付きの内容に一時的に差し替え、有効化時に元の文言へ戻す。 */
    function _setMenuItemGate(elId, available, reasonText) {
        const el = document.getElementById(elId);
        if (!el) return;
        if (available) {
            el.classList.remove('disabled');
            if (el.dataset.tipOriginal !== undefined) {
                el.setAttribute('data-tip', el.dataset.tipOriginal);
                delete el.dataset.tipOriginal;
            }
        } else {
            el.classList.add('disabled');
            if (el.dataset.tipOriginal === undefined) {
                el.dataset.tipOriginal = el.getAttribute('data-tip') || '';
            }
            el.setAttribute('data-tip', reasonText);
        }
    }

    /* ★ 入口導線改善②: view-box全体をドロップゾーン化。
       ドラッグ中はオーバーレイを表示し、ドロップされたファイルを
       既存の loadVideoFile() にそのまま渡す（読み込みロジックは分岐しない）。 */
    function _initDropZone() {
        const dropZone = document.getElementById('view-box-main');
        const dropOverlay = document.getElementById('drop-overlay');
        if (!dropZone || !dropOverlay) return;

        let dragCounter = 0; // 子要素間のdragenter/dragleaveの往復による誤消灯を防ぐ

        dropZone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            dropOverlay.classList.add('active');
        });
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault(); // これが無いとdropイベントが発火しない
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter = Math.max(0, dragCounter - 1);
            if (dragCounter === 0) dropOverlay.classList.remove('active');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            dropOverlay.classList.remove('active');
            const file = e.dataTransfer?.files?.[0];
            if (file) loadVideoFile(file);
        });
    }

    function _updateFeatureAvailability() {
        const hasVideo   = !!(video && video.videoWidth > 0);
        const hasHistory = state.history && state.history.length > 0;

        _setMenuItemGate('menu-item-calibration', hasVideo, '動画を読み込むと使用できます');
        _setMenuItemGate('menu-item-measurement', hasVideo, '動画を読み込むと使用できます');
        _setMenuItemGate('menu-item-export-modal', hasVideo, '動画を読み込むと使用できます');
        _setMenuItemGate('menu-item-export-csv', hasHistory, '動画を再生して解析データを作成すると使用できます');
        _setMenuItemGate('menu-item-rom', hasHistory, '動画を再生して解析データを作成すると使用できます');
    }

    /* ★ v14.1: メモリバッジの「保存してクリア」アクション */
    // ★ 修正4: exportJSON の Promise 完了を待ってから履歴をクリア（固定500ms廃止）
    function exportAndClearHistory() {
        if (state.history.length === 0) { _updateMemoryBadge(0); return; }

        const wasPlaying = !video.paused;
        if (wasPlaying) safePauseVideo(); // 書き出し中に新フレームが積まれないよう停止

        exportJSON()
            .then(() => {
                resetTrackingCaches();
                console.info('[v14] history cleared after export');
                if (wasPlaying) {
                    video.play().catch(err => {
                        if (err.name !== 'AbortError') console.warn('resume after clear:', err);
                    });
                }
            })
            .catch(err => {
                // 保存失敗時は再生だけ再開（データは消さない）
                console.warn('[v14] exportAndClear failed:', err.message);
                if (wasPlaying) {
                    video.play().catch(e => { if (e.name !== 'AbortError') console.warn(e); });
                }
            });
    }

    /* ============================================================
    15. Video & Control  (v10 完全安定版)
    ============================================================ */

    const video = document.getElementById('input-video');

    // ★ 全画面タイマー管理: enforceInlineVideoMode のガード判定より前に宣言が必要
    let _fsBeginTimer = null;
    let _fsEndTimer = null;
    let _fsSyncTimer = null;

    function enforceInlineVideoMode() {
        if (!video) return;
        try { video.setAttribute('playsinline', ''); } catch (_) {}
        try { video.setAttribute('webkit-playsinline', ''); } catch (_) {}
        try { video.setAttribute('disablePictureInPicture', ''); } catch (_) {}
        try { video.setAttribute('disableRemotePlayback', ''); } catch (_) {}
        try { video.setAttribute('x-webkit-airplay', 'deny'); } catch (_) {}
        try { video.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback'); } catch (_) {}
        try { video.playsInline = true; } catch (_) {}
        try { video.muted = true; } catch (_) {}
        try { video.disablePictureInPicture = true; } catch (_) {}
        try { video.disableRemotePlayback = true; } catch (_) {}
        try {
            // ★ 全画面タイマーが pending 中は webkitSetPresentationMode を呼ばない
            //   タイマー側が確実に 'inline' に戻すため、ここで二重呼び出しすると
            //   presentationmodechanged が連鎖して _fsSyncTimer が積み重なる
            if (_fsBeginTimer === null && _fsEndTimer === null) {
                if (typeof video.webkitSetPresentationMode === 'function' && video.webkitPresentationMode !== 'inline') {
                    video.webkitSetPresentationMode('inline');
                }
            }
        } catch (_) {}
    }

    function syncIOSViewport() {
        requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
            requestRepaint();
        });
    }

    enforceInlineVideoMode();
    ['loadedmetadata', 'loadeddata', 'play', 'pause'].forEach(evt => {
        video.addEventListener(evt, () => {
            enforceInlineVideoMode();
            syncIOSViewport();
        });
    });
    video.addEventListener('enterpictureinpicture', async () => {
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
        } catch (_) {}
    });
    // ★ 全画面タイマー競合防止: 複数イベントが重複発火した場合に古いタイマーをキャンセル
    video.addEventListener('webkitbeginfullscreen', () => {
        // ★ iOS全画面アニメーション完了待ち: 約300ms必要なため350msに設定
        //   100ms だとアニメーション中にOSに握りつぶされる
        clearTimeout(_fsBeginTimer);
        _fsBeginTimer = setTimeout(() => {
            try { if (typeof video.webkitSetPresentationMode === 'function') video.webkitSetPresentationMode('inline'); } catch (_) {}
            try { if (typeof video.webkitExitFullScreen === 'function') video.webkitExitFullScreen(); } catch (_) {}
            _fsBeginTimer = null; // ★ ガードを解除: enforceInlineVideoMode が再び動けるように
            syncIOSViewport();
        }, 350);
    });
    // ★ iOS対応: 全画面から戻った直後にも inline を再ロック
    //   OSのアニメーション完了後に呼ぶため 200ms 待つ
    video.addEventListener('webkitendfullscreen', () => {
        clearTimeout(_fsEndTimer);
        _fsEndTimer = setTimeout(() => {
            _fsEndTimer = null; // ★ ガードを解除してから enforceInlineVideoMode を呼ぶ
            enforceInlineVideoMode();
            syncIOSViewport();
        }, 200);
    });
    // ★ webkitpresentationmodechanged はアニメーション完了後に発火する最も確実なイベント
    //   beginfullscreen/endfullscreen のタイムアウトが間に合わなかった場合の最終防衛線
    video.addEventListener('webkitpresentationmodechanged', () => {
        try {
            if (video.webkitPresentationMode && video.webkitPresentationMode !== 'inline' && typeof video.webkitSetPresentationMode === 'function') {
                video.webkitSetPresentationMode('inline');
                // 状態確定後にビューポートを同期（begin/end タイマーと競合しないよう独立管理）
                clearTimeout(_fsSyncTimer);
                _fsSyncTimer = setTimeout(syncIOSViewport, 50);
            }
        } catch (_) {}
    });
    window.addEventListener('orientationchange', () => setTimeout(syncIOSViewport, 150));


    /* ------------------------------------------------------------
    1. MediaPipe フレーム処理（v10）
    ------------------------------------------------------------ */
    function startRenderLoop() {
        if (state.loopRunning) return;
        state.loopRunning = true;

        let lastVideoTime = -1;

        const loop = () => {
            if (!state.loopRunning) { _renderLoopRaf = 0; return; }

            if (_rec2dRunning && state.repeatB !== null && video.currentTime >= state.repeatB) stopRecording2D();
            if (_rec3dRunning && state.repeatB !== null && video.currentTime >= state.repeatB) stopRecording3D();

            if (!video.seeking && !state.isSeekingFrame && (_rec2dRunning || _rec3dRunning) && state.repeatA !== null) {
                if (video.currentTime < state.repeatA) video.currentTime = state.repeatA;
            }

            if (!video.paused && !video.ended && detector && !state.isModelChanging) {
                const currentTime = video.currentTime;
                // ★ 高Hz対応: != ではなく閾値比較（浮動小数点誤差で同フレームを2回解析しない）
                // ★ iOS対応: readyState >= 2 を確認してからdetectForVideoを呼ぶ（デコード競合防止）
                if (Math.abs(currentTime - lastVideoTime) > 1e-4 && video.readyState >= 2) {
                    lastVideoTime = currentTime;
                    try {
                        const result = detector.detectForVideo(video, performance.now());
                        if (result?.landmarks?.length > 0) onPoseResults(result);
                    } catch (e) {
                        console.warn('detectForVideo skip:', e.message);
                    }
                }
            }

            _renderLoopRaf = requestAnimationFrame(loop);
        };

        _renderLoopRaf = requestAnimationFrame(loop);
    }

    function togglePlay() {
        const btnPlay = document.getElementById('btn-play');

        if (video.paused) {
            state.isPlaying = true;
            video.play().catch(err => {
                if (err.name === 'AbortError') return;
                state.isPlaying = false;
                stopRenderLoop(); // ★ Bug-V fix: 再生拒否時に空回りするループを止める
                if (btnPlay) btnPlay.innerHTML = '<i class="fas fa-play"></i>'; // ★ 修正: ボタン表示も復帰
                if (err.name === 'NotAllowedError') {
                    alert('再生が許可されませんでした。\n省電力モードを解除するか、画面をタップしてから再度お試しください。');
                } else {
                    console.warn('video.play() error:', err);
                }
            });

            if (detector && video.readyState >= 2) {
                try {
                    const result = detector.detectForVideo(video, performance.now());
                    if (result?.landmarks?.length > 0) onPoseResults(result);
                } catch (e) { console.warn("warm-up detect skip:", e.message); }
            }

            startRenderLoop();
            if (btnPlay) btnPlay.innerHTML = '<i class="fas fa-pause"></i>';
        } else {
            state.isPlaying = false;
            safePauseVideo();
            stopRenderLoop();
            if (btnPlay) btnPlay.innerHTML = '<i class="fas fa-play"></i>';
        }
    }

    /* seekAndDetect ------------------------------------------------
       修正1(強化): トークン方式 + seeking/seeked 両イベント監視
         - settle() は token に関わらず常に isSeekingFrame を落とす
           （高負荷でトークンが飛んでもデッドロックしない）
         - タイムアウトを 600ms に延長し高負荷デコーダーに対応
         - video.seeking フラグを追加チェック
    ------------------------------------------------------------ */
    function seekAndDetect(t) {
        const dur = Number(video?.duration);
        if (!Number.isFinite(dur) || dur <= 0) return;

        const clamped = Math.max(0, Math.min(dur, Number.isFinite(t) ? t : 0));

        if (!detector) {
            try { video.currentTime = clamped; } catch (_) {}
            updateHandleOnly();
            return;
        }

        if (state.isSeekingFrame) {
            _pendingSeekTime = clamped;   // 最後の要求だけ保持（捨てない）
            updateHandleOnly();
            return;
        }

        const token = ++_seekToken;
        state.isSeekingFrame = true;
        state.isEmaResetTriggered = true;
        state.worldOrigin = null;

        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            // ★ 修正1: token に関わらず isSeekingFrame を必ず解除
            //   高負荷でトークンが飛んでも絶対にデッドロックしない
            state.isSeekingFrame = false;
            if (_pendingSeekTime !== null) {
                const next = _pendingSeekTime;
                _pendingSeekTime = null;
                _defer(() => seekAndDetect(next));
            }
        };

        const onSeeked = () => {
            // ★ 修正1: 古いトークンでも settle() を呼ぶ（ロック解除優先）
            //   ただし描画は最新トークンのみ実行
            try {
                if (token === _seekToken &&
                    video.readyState >= 2 && !state.isModelChanging && detector) {
                    const result = detector.detectForVideo(video, performance.now());
                    if (result?.landmarks?.length > 0) onPoseResults(result);
                    else updateUI();
                } else if (token === _seekToken) {
                    updateHandleOnly();
                }
            } catch (err) {
                console.error('Seek detection error:', err);
            } finally {
                settle(); // ★ 常に settle（トークン不一致でもロック解除）
            }
        };

        // ★ 修正1: タイムアウトを 600ms に延長（高負荷デコーダーへの耐性）
        const timeoutId = setTimeout(() => {
            console.warn('[KS] seek timeout — force unlock (token:', token, '/ current:', _seekToken, ')');
            // 残留 seeked リスナーを除去してからロック解除
            video.removeEventListener('seeked', onSeeked);
            settle();
        }, 600);

        video.addEventListener('seeked', onSeeked, { once: true });

        try {
            if (Math.abs(video.currentTime - clamped) < 1e-4) {
                _defer(onSeeked);
            } else {
                video.currentTime = clamped;
            }
        } catch (err) {
            console.error('video.currentTime set failed:', err);
            settle();
        }

        updateHandleOnly();
    }

    function getSeekRatio(clientX) {
        const rect = document.getElementById('seekbar-container').getBoundingClientRect();
        if (!rect.width) return 0;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    /* ------------------------------------------------------------
    3. シーク（←→ ボタン）
    ------------------------------------------------------------ */
    function seek(offset) {
        // ★ 修正3: コマ送り中は A/B ループ判定をバイパス
        state.isStepping = true;
        seekAndDetect(video.currentTime + offset);
        // seeked 完了またはタイムアウト後にフラグを解除
        const clearStep = () => { state.isStepping = false; };
        video.addEventListener('seeked', clearStep, { once: true });
        setTimeout(clearStep, 700); // フォールバック
    }

    /* ------------------------------------------------------------
    4. A/B リピート設定
    ------------------------------------------------------------ */
    // ★ 修正3: A/B 最小区間（秒）— これ未満だとループ時にチャタリングが起きる
    const _AB_MIN_SPAN = 0.3;

    function setRepeatA() {
        state.repeatA = video.currentTime;

        if (state.repeatB !== null && state.repeatB <= state.repeatA) {
            state.repeatB = null;
        }
        updateHandleOnly();
        updateStatusPills();
    }

    function setRepeatB() {
        if (state.repeatA === null) {
            alert("先にA点を設定してください");
            return;
        }

        state.repeatB = video.currentTime;

        if (state.repeatB <= state.repeatA) {
            [state.repeatA, state.repeatB] = [state.repeatB, state.repeatA];
        }
        if (state.repeatB - state.repeatA < _AB_MIN_SPAN) {
            const dur = video.duration || (state.repeatA + _AB_MIN_SPAN);
            if (state.repeatA + _AB_MIN_SPAN > dur) {
                state.repeatA = Math.max(0, dur - _AB_MIN_SPAN);
                state.repeatB = dur;
            } else {
                state.repeatB = state.repeatA + _AB_MIN_SPAN;
            }
        }
        updateHandleOnly();
        updateStatusPills();

        if (state.repeatA !== null && state.repeatB !== null) {
            seekAndDetect(state.repeatA);
            if (!state.isPlaying) togglePlay();
        }
    }

    function clearRepeat() {
        state.repeatA = null;
        state.repeatB = null;
        updateHandleOnly();
        updateStatusPills();
    }

    /* ------------------------------------------------------------
    5. UI 更新（時間表示 + A/B + ハンドル）
    ------------------------------------------------------------ */
    function updateUI() {
        if (!video.duration) return;

        // 時刻表示
        document.getElementById('time-display').innerText =
            formatTime(video.currentTime);

        // A/B リピート
        // ★ 修正3: コマ送り中（isStepping）は A/B ループ判定をスキップ
        // ★ 修正: !video.paused を追加 — isPlaying フラグがストールの状態で
        //   一時停止中に意図せず Aジャンプが起こるのを防ぐ
        if (state.isPlaying && !video.paused && !state.isStepping && state.repeatA !== null && state.repeatB !== null) {
            if (video.currentTime >= state.repeatB ||
                video.currentTime < state.repeatA) {
                // ★ ジャンプ開始：history記録のみブロック（描画は継続）
                state.abJumping = true;
                state.seekGeneration++;
                video.currentTime = state.repeatA;

                // seeked 待ちで解除 + 200ms タイムアウト安全策
                // （currentTime === repeatA の場合など seeked が発火しないケースの保険）
                const gen = state.seekGeneration;
                const releaseJump = () => {
                    if (state.seekGeneration === gen) state.abJumping = false;
                };
                video.addEventListener('seeked', releaseJump, { once: true });
                setTimeout(releaseJump, 200);
            }
        }

        updateHandleOnly();
    }

    /* ------------------------------------------------------------
    6. ハンドル & A/B マーカー更新
    ------------------------------------------------------------ */
    function updateHandleOnly() {
        const duration = video.duration;
        if (!duration) return;

        // ハンドル
        const handle = document.getElementById('seekbar-handle');
        if (handle) {
            handle.style.left = `${(video.currentTime / duration) * 100}%`;
        }

        // A/B マーカー
        const markerA = document.getElementById('seekbar-marker-A');
        const markerB = document.getElementById('seekbar-marker-B');
        const highlight = document.getElementById('seekbar-highlight');

        if (state.repeatA !== null && markerA) {
            markerA.style.left = `${(state.repeatA / duration) * 100}%`;
            markerA.style.display = 'block';
        } else if (markerA) markerA.style.display = 'none';

        if (state.repeatB !== null && markerB) {
            markerB.style.left = `${(state.repeatB / duration) * 100}%`;
            markerB.style.display = 'block';
        } else if (markerB) markerB.style.display = 'none';

        if (state.repeatA !== null && state.repeatB !== null && highlight) {
            const left = Math.min(state.repeatA, state.repeatB);
            const width = Math.abs(state.repeatB - state.repeatA);

            highlight.style.left = `${(left / duration) * 100}%`;
            highlight.style.width = `${(width / duration) * 100}%`;
            highlight.style.display = 'block';
        } else if (highlight) {
            highlight.style.display = 'none';
        }
    }

    /* ------------------------------------------------------------
    7. 時刻フォーマット
    ------------------------------------------------------------ */
    function formatTime(s) {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    /* ------------------------------------------------------------
    8. 再生速度ボタン
    ------------------------------------------------------------ */
    document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.speed-btn')
                .forEach(b => b.classList.remove('active'));

            btn.classList.add('active');
            video.playbackRate = parseFloat(btn.dataset.speed);
        });
    });

    /* ============================================================
        16. Tick Marks & Event Listeners & Bootstrap
    ============================================================ */
    function updateSeekbarVisual() {
        const container = document.getElementById('seekbar-container');
        if (!container || !video.duration) return;

        container.innerHTML = '';
        const duration = video.duration;

        // ★ 背景トラック（overflow:hidden はここのみ → ハンドルがクリップされない）
        const track = document.createElement('div');
        track.id = 'seekbar-track';
        container.appendChild(track);

        // --- 10秒ごとの背景帯 ---
        for (let i = 0; i < Math.ceil(duration / 10); i++) {
            const band = document.createElement('div');
            band.style.cssText = `position:absolute;left:${(i*10/duration)*100}%;width:${(Math.min(10,duration-i*10)/duration)*100}%;height:100%;background:${i%2===0?'rgba(255,255,255,0.03)':'transparent'};pointer-events:none;`;
            track.appendChild(band);
        }

        // --- 目盛り ---
        const step = 0.5;
        for (let t = 0; t <= duration; t += step) {
            const is10s = Math.abs(t % 10) < 0.001;
            const is1s  = Math.abs(t % 1)  < 0.001;
            const tick = document.createElement('div');
            tick.style.cssText = `position:absolute;left:${(t/duration)*100}%;bottom:0;pointer-events:none;`;
            if (is10s) tick.style.cssText += `width:2px;height:60%;background:rgba(255,255,255,0.8);`;
            else if (is1s) tick.style.cssText += `width:1px;height:40%;background:rgba(255,255,255,0.4);`;
            else tick.style.cssText += `width:1px;height:20%;background:rgba(255,255,255,0.15);`;
            track.appendChild(tick);
        }

        // --- A/B ハイライト（container 直接子 → overflow:visible で見える） ---
        const highlight = document.createElement('div');
        highlight.id = 'seekbar-highlight';

        const startDrag = (type, e) => {
            e.stopPropagation();
            // ★ v15h: ドラッグ開始時にスクロール干渉を即ブロック
            if (e.cancelable) e.preventDefault();
            state.dragging.type = type;
            if (type === 'highlight-move') {
                state.dragging.startX = getSeekRatio((e.touches?.[0] ?? e).clientX);
                state.dragging.startA = state.repeatA;
                state.dragging.startB = state.repeatB;
            }
        };
        const edgeL = document.createElement('div');
        edgeL.className = 'sh-edge sh-edge-l';
        edgeL.addEventListener('mousedown', e => startDrag('A', e));
        edgeL.addEventListener('touchstart', e => startDrag('A', e), { passive: false });

        const edgeR = document.createElement('div');
        edgeR.className = 'sh-edge sh-edge-r';
        edgeR.addEventListener('mousedown', e => startDrag('B', e));
        edgeR.addEventListener('touchstart', e => startDrag('B', e), { passive: false });

        highlight.addEventListener('mousedown', e => {
            if (e.target === edgeL || e.target === edgeR) return;
            startDrag('highlight-move', e);
        });
        highlight.addEventListener('touchstart', e => {
            if (e.target === edgeL || e.target === edgeR) return;
            startDrag('highlight-move', e);
        }, { passive: false });

        highlight.appendChild(edgeL);
        highlight.appendChild(edgeR);
        container.appendChild(highlight);

        // --- A/B マーカー ---
        ['A', 'B'].forEach(type => {
            const marker = document.createElement('div');
            marker.id = `seekbar-marker-${type}`;
            marker.className = 'seekbar-marker';
            marker.style.display = 'none';
            const onDown = e => {
                e.stopPropagation();
                if (e.cancelable) e.preventDefault();
                state.dragging.type = type;
            };
            marker.addEventListener('mousedown', onDown);
            // ★ v15h: passive:false でマーカードラッグ中のスクロール干渉を防ぐ
            marker.addEventListener('touchstart', onDown, { passive: false });
            container.appendChild(marker);
        });

        // --- ハンドル（●）container 直接子 → overflow:visible でクリップされない ---
        const handle = document.createElement('div');
        handle.id = 'seekbar-handle';
        const onHandleDown = e => {
            e.stopPropagation();
            // ★ v15h: タッチ時もスクロール干渉を防ぐ
            if (e.cancelable) e.preventDefault();
            state.dragging.type = 'handle';
        };
        handle.addEventListener('mousedown', onHandleDown);
        handle.addEventListener('touchstart', onHandleDown, { passive: false });
        container.appendChild(handle);
    }

    function registerSeekbarEvents() {
        const seekbar = document.getElementById('seekbar-container');
        if (!seekbar) return;

        const onSeekDown = (clientX) => {
            state.dragging.type = 'handle';
            const t = getSeekRatio(clientX) * video.duration;
            seekAndDetect(t);
        };
        seekbar.addEventListener('mousedown', e => onSeekDown(e.clientX));
        // ★ v15h: passive:false にしてシーク中のページスクロールを preventDefault できるようにする
        seekbar.addEventListener('touchstart', e => {
            e.preventDefault(); // スクロールと競合させない
            onSeekDown(e.touches[0].clientX);
        }, { passive: false });
    }


    // Event listeners
    document.getElementById('btn-play').onclick = togglePlay;

    // dynamic settings listeners
    document.getElementById('ema-slider').addEventListener('input', (e) => {
        state.emaAlpha = parseFloat(e.target.value);
        document.getElementById('ema-val-label').innerText = state.emaAlpha.toFixed(2);
    });
    document.getElementById('trail-slider').addEventListener('input', (e) => {
        state.trailLength = parseInt(e.target.value);
        document.getElementById('trail-val-label').innerText = state.trailLength + 'f';
        requestRepaint(); // ★ 軌跡長変更は停止中も即反映
    });
    document.getElementById('vis-slider').addEventListener('input', (e) => {
        state.visibilityThreshold = parseFloat(e.target.value);
        document.getElementById('vis-val-label').innerText = state.visibilityThreshold.toFixed(2);
        requestRepaint(); // ★ フィルタ変更は停止中も即反映
    });
    document.getElementById('check-show-dots').onchange = (e) => {
        state.showDots = e.target.checked;
        requestRepaint(); // ★ ドット表示切替も停止中に即反映
    };

    // ★ v14.1: 3D相対座標モードトグル
    document.getElementById('check-relative-origin').onchange = (e) => {
        state.relativeOriginMode = e.target.checked;
        state.worldOrigin = null;
        state.isEmaResetTriggered = true;
        state.smoothedWorldLandmarks = null;

        // ★ v14.1 fix: controls.target をモードに合わせて即時補正
        if (controls) {
            if (state.relativeOriginMode) {
                // 相対モードON → 3Dモデルは常に原点付近に来るので注視点を(0,0,0)へ
                controls.target.set(0, 0, 0);
            } else {
                // 相対モードOFF → 腰の絶対座標付近を注視（lastValidFrame があれば）
                const f = state.lastValidFrame;
                const w = f?.w;
                if (w && w[23] && w[24]) {
                    const hx = (w[23].x + w[24].x) * 0.5 * 1.5;
                    const hy = -(w[23].y + w[24].y) * 0.5 * 1.5;
                    const hz = (w[23].z + w[24].z) * 0.5 * 1.5;
                    controls.target.set(hx, hy, hz);
                } else {
                    controls.target.set(0, 0, 0);
                }
            }
            controls.update();
            // 一時停止中なら即レンダリング
            if (video.paused && renderer && scene && camera) {
                renderer.render(scene, camera);
            }
        }
    };

    /* ============================================================
       v14.3: 未保存バッジ（データボタン右上の赤い●）
    ============================================================ */
    function _showUnsavedBadge(show) {
        const dot = document.getElementById('unsaved-dot');
        if (dot) dot.style.display = show ? 'block' : 'none';
    }

    /* ============================================================
       v14.3: 動画終了時 → 最終フレームで停止 + 未保存バッジ表示
    ============================================================ */
    video.addEventListener('ended', () => {
        state.isPlaying = false;
        stopRenderLoop(); // 修正6: ended 後も rAF が回り続けるのを防ぐ
        const btnPlay = document.getElementById('btn-play');
        if (btnPlay) btnPlay.innerHTML = '<i class="fas fa-play"></i>';

        // 最終フレームのまま停止（先頭に戻さない）
        // history があればデータが存在する → バッジで保存を促す
        if (state.history.length > 0) {
            _showUnsavedBadge(true);
        }
    });

    // file input
    document.getElementById('file-input').onchange = function(e) {
        const file = e.target.files[0];
        // ★ Bug-P fix: value をリセットしないと同一ファイルを再選択しても change が発火しない
        e.target.value = '';
        if (!file) return;
        loadVideoFile(file);
    };

    // ★ 入口導線改善①②: 動画ロード処理を共通関数化し、file-input とドラッグ&ドロップの
    //   両方から呼べるようにする（内容は従来のonchangeハンドラと同一、分岐なし）
    function loadVideoFile(file) {
        if (!file) return;
        if (!file.type || !file.type.startsWith('video/')) {
            alert('動画ファイルを選択してください。');
            return;
        }

        // 動画が渡された時点でCTA/ドロップオーバーレイを隠す
        const emptyStateEl = document.getElementById('empty-state');
        if (emptyStateEl) emptyStateEl.classList.add('hidden');
        const dropOverlayEl = document.getElementById('drop-overlay');
        if (dropOverlayEl) dropOverlayEl.classList.remove('active');

        // ★ 修正4: 録画中に別動画を読み込むとエンコーダーが壊れるため強制停止
        //   解像度が変わった瞬間 MediaRecorder がサイレントに破損ファイルを生成する
        if (_rec2dRunning) {
            console.info('[KS] 録画中に新動画が選択されました — 2D録画を自動停止します');
            stopRecording2D();
        }
        if (_rec3dRunning) {
            console.info('[KS] 録画中に新動画が選択されました — 3D録画を自動停止します');
            stopRecording3D();
        }

        state.currentFileName = file.name;
        // ★ Bug-4 fix: revokeCurrentVideoObjectURL() で前の URL を確実に解放
        revokeCurrentVideoObjectURL();

        // ★ 修正3(WASM): 20本ごとに detector を再生成してヒープ断片化をリセット
        //   長時間連続稼働でのWASMクラッシュ（OOM/index out of bounds）を予防
        state.videoSwitchCount++;
        if (state.videoSwitchCount % 20 === 0 && detector) {
            console.info(`[KS] WASM heap refresh at video #${state.videoSwitchCount}`);
            disposeDetector(); // detector = null になる
            // 動画読み込み完了後（onloadedmetadata）に initMediaPipe を呼ぶため
            // ここでは破棄のみ。ウォームアップは onloadedmetadata 内で行われる
        }
        // ★ 修正3: 新動画読み込み時に進行中の GIF エクスポートを強制中断
        if (_gifInstance && _gifExportRunning) {
            try { _gifInstance.abort(); } catch (_) {}
        }
        const url = URL.createObjectURL(file);
        _videoObjectUrl = url;   // ★ Bug-4 fix: 次回解放できるよう変数に保持
        video.src = url;

        // ★ v14: 新動画読み込み時は全状態を完全リセット
        state.history = [];
        state.smoothedLandmarks = null;
        state.smoothedWorldLandmarks = null;
        state.abJumping = false;
        state.lastValidFrame = null;
        state.lastReliableLandmarks = null;
        state.repeatA = null;
        state.repeatB = null;
        state.worldOrigin = null;
        state.isEmaResetTriggered = true; // ★ 修正: 新動画で EMA もリセット
        state.segments = []; // ★ 修正: 旧動画の区間チップが残らないようクリア
        _showUnsavedBadge(false); // ★ v14.3: 新動画では未保存バッジをリセット
        _updateMemoryBadge(0);
        renderSegChips(); // ★ 修正: 区間チップ表示をリフレッシュ
        _updateFeatureAvailability(); // ★ 入口導線改善④: 履歴クリアに合わせて一旦無効化

        // ★ Bug-U fix: 前動画の骨格残像（ゴースト）を即座に消去
        try {
            if (typeof draw3D === 'function') {
                draw3D([]);          // 3Dプール全非表示
                update3DTrail();     // 3D軌跡クリア
                if (typeof renderer !== 'undefined' && scene && camera) {
                    renderer.render(scene, camera);
                }
            }
        } catch (_) {}
        const _c2d = document.getElementById('canvas-2d');
        if (_c2d) {
            _c2d.getContext('2d').clearRect(0, 0, _c2d.width, _c2d.height);
        }

        video.onloadedmetadata = () => {
            state.videoDuration = video.duration;
            // ★ Bug4修正: 録画用に動画の実サイズを保存
            state.baseWidth  = video.videoWidth  || 1280;
            state.baseHeight = video.videoHeight || 720;

            // ★ 修正4b: 高解像度動画の警告（モバイルでのデコーダー限界対策）
            if (state.baseWidth > 1920 || state.baseHeight > 1920) {
                console.warn(`[KS] 高解像度動画: ${state.baseWidth}x${state.baseHeight}`);
                alert(`この動画の解像度（${state.baseWidth}×${state.baseHeight}）は非常に高いため、\nモバイル端末や低スペックPCでは解析が不安定になることがあります。\n解析精度を「Lite」に下げることをお勧めします。`);
            }
            // ★ 修正③: VFR注記をUIに表示
            // ★ 修正: loader はこの時点で既に隠されているため、loader-vfr の display:block は
            //   ユーザーに見えない。console のみに留める。
            console.info('[KS] Tip: VFR動画はシーク精度が下がることがあります。CFR変換を推奨します。');

            updateSeekbarVisual();
            updateUI();
            state.worldOrigin = null; // ★ 新しい動画の原点をリセット
            _updateFeatureAvailability(); // ★ 入口導線改善④: 動画依存メニューを有効化

            // ★ WASM リフレッシュ後（detector===null）は再初期化してからウォームアップ
            if (!detector) {
                console.info('[KS] detector is null — re-initializing MediaPipe (WASM heap refresh)');
                initMediaPipe().catch(e => console.error('[KS] re-init failed:', e));
            }

            // ★ ここでウォームアップ（最重要）
            if (detector && video.readyState >= 2) {
                try {
                    const warm = detector.detectForVideo(video, performance.now());
                    if (warm?.landmarks?.length > 0) {
                        onPoseResults(warm);
                    }
                } catch (err) {
                    console.warn("warm-up detect skip:", err.message);
                }
            }

            video.currentTime = 0;

            video.onseeked = () => {
                video.onseeked = null;

                // ★ 停止中の初回フレーム解析
                if (!state.isPlaying && detector && video.readyState >= 2) {
                    try {
                        const result = detector.detectForVideo(video, performance.now());
                        if (result?.landmarks?.length > 0) onPoseResults(result);
                    } catch (err) {
                        console.warn("initial detect skip:", err.message);
                    }
                }
            };
        };
    }

    // Apply model button
        const applyBtn = document.getElementById('apply-model-btn');
            if (applyBtn) {
                applyBtn.addEventListener('click', async () => {
                    // ★ Bug-Q fix: 二重クリック防止
                    if (state.isModelChanging) return;

                    const complexity = parseInt(document.getElementById('model-complexity-select').value);
                    const loader = document.getElementById('loader');
                    const loaderText = document.getElementById('loader-text');

                    if (loader) loader.style.display = 'flex';
                    if (loaderText) loaderText.innerText = 'モデルを再構成中...';

                    // ★ Bug-Q fix: 解析ループを完全停止してから WASM を操作する
                    const wasPlaying = !video.paused;
                    if (wasPlaying) video.pause();
                    state.isModelChanging = true;
                    applyBtn.disabled = true;

                    try {
                        // ★ Tasks API 用のモデルパス（initMediaPipe と同じ URL を使用）
                        const modelPath =
                            complexity === 0
                                ? "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
                                : complexity === 2
                                ? "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task"
                                : "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

                        // ★ Tasks API の正しい setOptions
                        await detector.setOptions({
                            baseOptions: { modelAssetPath: modelPath }
                        });

                        // ★ 履歴とスムージングをリセット
                        state.history = [];
                        state.smoothedLandmarks = null;
                        state.smoothedWorldLandmarks = null;
                        state.lastValidFrame = null;
                        state.lastReliableLandmarks = null;
                        // ★ 修正: モデル変更で世界座標のスケールが変わるため原点もリセット
                        state.worldOrigin = null;
                        state.isEmaResetTriggered = true;

                        alert("モデル精度を更新し、履歴をリセットしました。");

                    } catch (e) {
                        console.error("モデル適用エラー:", e);
                        alert("モデル適用中にエラーが発生しました。コンソールを確認してください。");

                    } finally {
                        // ★ Bug-Q fix: ロックを必ず解除してから再生再開
                        state.isModelChanging = false;
                        applyBtn.disabled = false;
                        if (loader) loader.style.display = 'none';
                        if (wasPlaying) {
                            video.play().catch(err => {
                                if (err.name !== 'AbortError') console.warn('play after model change:', err);
                            });
                        } else if (video.readyState >= 2 && detector) {
                            // ★ 停止中なら1フレーム解析して画面を更新
                            try {
                                const result = detector.detectForVideo(video, performance.now());
                                if (result?.landmarks?.length > 0) onPoseResults(result);
                            } catch (err) {
                                console.warn("post-model detect skip:", err.message);
                            }
                        }
                    }
                });
            }

    // Bootstrap
    window.onload = async () => {
        try {
            initAccordion();
            initMobileOverlay();
            initTapSelect();
            updateStatusPills();
            updateScrollFade();
            // resize は checkMobileLayout 内で updateScrollFade も呼ぶので1本に統合
            initThree();

            // ★ 初回 3D 描画を強制
            state.needsRender3D = true;

            // ★ 入口導線改善②④: DOM構築のみに依存する初期化はMediaPipeロード(ネットワーク依存)を
            //   待たずに先に済ませる。initMediaPipe()が遅延・失敗してもUI導線は機能させる。
            _updateFeatureAvailability(); // 初期状態は動画依存メニューを無効化
            _initDropZone();              // ドラッグ&ドロップで動画投入

            await initMediaPipe();
            refreshJointUI();

            animate();                 // ★ 1回だけ呼ぶ
            updateSeekbarVisual();
            registerSeekbarEvents();
            installLifecycleGuards(); // ★ 修正7: visibilitychange / pagehide を登録

        } catch (e) {
            console.error("初期化エラー:", e);
            document.getElementById('loader-text').innerText =
                "エラーが発生しました: " + e.message;
        }
    };
            
    /* ------------------------------------------------------------
    Mouse & Touch unified drag handler
    ------------------------------------------------------------
    ★ 修正: 以前ここに getSeekRatio() の重複定義があったため削除
       （L2735 に 1 つだけ存在した状態に統一）
    ------------------------------------------------------------ */

    /* ★ v14.3: rAF スロットリング — input が詰まってもブラウザの更新レートに同期 */
    let _rafSeekPending = false;
    let _rafSeekT = 0;

    /* ★ v14.3: シークツールチップ（ドラッグ中だけ表示） */
    function _updateSeekTooltip(clientX, t) {
        const tip = document.getElementById('seek-tooltip');
        if (!tip) return;
        const frame  = Math.round(t * 30); // 30fps 想定
        const mm     = Math.floor(t / 60).toString().padStart(2, '0');
        const ss     = (t % 60).toFixed(2).padStart(5, '0');
        tip.textContent = `${mm}:${ss}  f${frame}`;

        // ツールチップ位置をハンドルの真上に
        const containerRect = document.getElementById('seekbar-container').getBoundingClientRect();
        const parentRect    = tip.parentElement.getBoundingClientRect();
        const leftPx = clientX - parentRect.left;
        tip.style.left    = leftPx + 'px';
        tip.style.display = 'block';
    }

    function _hideSeekTooltip() {
        const tip = document.getElementById('seek-tooltip');
        if (tip) tip.style.display = 'none';
    }

    function onDragMove(clientX) {
        if (!state.dragging.type) return;
        const t = getSeekRatio(clientX) * video.duration;

        if (state.dragging.type === 'A') {
            state.repeatA = t;
            updateHandleOnly();
        } else if (state.dragging.type === 'B') {
            state.repeatB = t;
            updateHandleOnly();
        } else if (state.dragging.type === 'handle') {
            /* ★ v14.3: rAF スロットリング — 最後の座標だけ使い、フレームレートに同期 */
            _rafSeekT = t;
            _updateSeekTooltip(clientX, t);
            if (!_rafSeekPending) {
                _rafSeekPending = true;
                requestAnimationFrame(() => {
                    try {
                        seekAndDetect(_rafSeekT);
                    } finally {
                        // ★ 修正1: 例外が発生してもフラグを必ず解除（デッドロック防止）
                        _rafSeekPending = false;
                    }
                });
            }
        } else if (state.dragging.type === 'highlight-move') {
            // ハイライト帯全体を移動（A/B を同量ずらす）
            const ratio = getSeekRatio(clientX);
            const dur = video.duration;
            const span = state.dragging.startB - state.dragging.startA;
            let newA = (ratio - state.dragging.startX) * dur + state.dragging.startA;
            newA = Math.max(0, Math.min(dur - span, newA));
            state.repeatA = newA;
            state.repeatB = newA + span;
            updateHandleOnly();
        }
    }

    function onDragEnd() {
        // A/B ドラッグ終了時に A>B なら swap
        if (state.dragging.type === 'A' || state.dragging.type === 'B') {
            if (state.repeatA !== null && state.repeatB !== null) {
                if (state.repeatA > state.repeatB) {
                    [state.repeatA, state.repeatB] = [state.repeatB, state.repeatA];
                }
                // ★ 修正3b: ドラッグ終了後にも最小区間を強制（チャタリング防止）
                if (state.repeatB - state.repeatA < _AB_MIN_SPAN) {
                    state.repeatB = Math.min(
                        state.repeatA + _AB_MIN_SPAN,
                        video.duration || state.repeatA + _AB_MIN_SPAN
                    );
                }
                updateHandleOnly();
            }
        }
        // ★ v14.3: ドラッグ終了でツールチップを非表示
        _hideSeekTooltip();
        state.dragging.type = null;
    }

    document.addEventListener('mousemove', e => onDragMove(e.clientX));
    document.addEventListener('mouseup', onDragEnd);
    document.addEventListener('touchmove', e => {
        if (!state.dragging.type) return;
        e.preventDefault();
        onDragMove(e.touches[0].clientX);
    }, { passive: false });
    document.addEventListener('touchend', onDragEnd);
    // ★ v15h: touchcancel でドラッグロックが残らないように（iOS で指2本・通知センターなど）
    document.addEventListener('touchcancel', onDragEnd);


    state.needsRender3D = false;

    function animate() {
        requestAnimationFrame(animate);

        let needs = state.needsRender3D;

        // OrbitControls のカメラ操作もオンデマンド描画対象
        if (controls) {
            const before = camera.position.clone();
            controls.update();
            if (!camera.position.equals(before)) {
                needs = true;
            }
        }

        if (needs) {
            renderer.render(scene, camera);
            state.needsRender3D = false;
        }
    }

    /* ============================================================
       17. CSV / JSON Export & Import
    ============================================================ */
    function exportCSV() {
        if (state.history.length === 0) {
            alert("出力するデータがありません。解析を行ってください。");
            return;
        }
        _showUnsavedBadge(false);

        const hasAB = state.repeatA !== null && state.repeatB !== null;
        const lines = [];

        // ヘッダー行: A/B区間マーカー列を末尾に追加
        lines.push("Time(s)," + allJoints.map(j => j.name).join(",") + ",AB_Marker");

        state.history.forEach(frame => {
            const t = frame.t ?? frame.time ?? 0;
            const row = [ t.toFixed(3) ];
            allJoints.forEach(j => {
                const val = (frame.a && frame.a[j.id] !== undefined)
                    ? frame.a[j.id]
                    : (frame.angles ? frame.angles[j.id] : null);
                row.push(val !== null && val !== undefined ? val.toFixed(2) : "");
            });
            // AB_Marker 列: A点=A, B点=B, 区間内=loop, それ以外は空欄
            let marker = "";
            if (hasAB) {
                if (Math.abs(t - state.repeatA) < 0.02) marker = "A";
                else if (Math.abs(t - state.repeatB) < 0.02) marker = "B";
                else if (t > state.repeatA && t < state.repeatB) marker = "loop";
            }
            row.push(marker);
            lines.push(row.join(","));
        });

        const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: 'text/csv;charset=utf-8;' });
        _download(blob, `analysis_${state.currentFileName || 'data'}.csv`);
    }

    /* ============================================================
    ROM（可動域）レポート
    ・state.history（または選択範囲）を走査し、関節ごとの
      最小/最大/ROM(可動域)/平均/最小最大の発生時刻を集計する
    ============================================================ */
    let _lastRomData = null; // exportRomCSV 用に直近の集計結果を保持

    function _romFmtTime(t) {
        return (t === null || t === undefined || Number.isNaN(t)) ? '--:--' : formatTime(t);
    }

    function openRomModal() {
        if (state.history.length === 0) {
            alert('解析データがありません。動画を再生してから開いてください。');
            return;
        }
        _populateRomScopeOptions();
        renderRomReport();
        document.getElementById('rom-modal').classList.add('open');
    }

    function closeRomModal() {
        document.getElementById('rom-modal').classList.remove('open');
    }

    function _populateRomScopeOptions() {
        const sel = document.getElementById('rom-scope-select');
        const prevValue = sel.value;
        const opts = [`<option value="all">全体（${state.history.length} フレーム）</option>`];

        if (state.repeatA !== null && state.repeatB !== null) {
            opts.push(`<option value="ab">現在の A/B 区間（${formatTime(state.repeatA)} - ${formatTime(state.repeatB)}）</option>`);
        }
        state.segments.forEach(seg => {
            opts.push(`<option value="seg:${seg.id}">${seg.name}（${formatTime(seg.a)} - ${formatTime(seg.b)}）</option>`);
        });

        sel.innerHTML = opts.join('');
        // 直前に選んでいた範囲がまだ存在するなら維持する（区間削除等で消えていれば 'all' にフォールバック）
        if ([...sel.options].some(o => o.value === prevValue)) sel.value = prevValue;
    }

    function _getRomScopeFrames(scope) {
        if (scope === 'ab' && state.repeatA !== null && state.repeatB !== null) {
            const lo = Math.min(state.repeatA, state.repeatB);
            const hi = Math.max(state.repeatA, state.repeatB);
            return state.history.filter(f => f.t >= lo && f.t <= hi);
        }
        if (typeof scope === 'string' && scope.startsWith('seg:')) {
            const id = Number(scope.slice(4));
            const seg = state.segments.find(s => s.id === id);
            if (seg) {
                const lo = Math.min(seg.a, seg.b);
                const hi = Math.max(seg.a, seg.b);
                return state.history.filter(f => f.t >= lo && f.t <= hi);
            }
        }
        return state.history; // 'all' またはフォールバック
    }

    function computeROM(frames) {
        const acc = {};
        allJoints.forEach(j => {
            acc[j.id] = { id: j.id, name: j.name, min: Infinity, max: -Infinity, tMin: null, tMax: null, sum: 0, count: 0 };
        });

        frames.forEach(frame => {
            const a = frame.a || {};
            for (const j of allJoints) {
                const v = a[j.id];
                if (v === null || v === undefined || Number.isNaN(v)) continue;
                const r = acc[j.id];
                r.count++;
                r.sum += v;
                if (v < r.min) { r.min = v; r.tMin = frame.t; }
                if (v > r.max) { r.max = v; r.tMax = frame.t; }
            }
        });

        return allJoints.map(j => {
            const r = acc[j.id];
            if (r.count === 0) {
                return { id: j.id, name: j.name, min: null, max: null, rom: null, mean: null, tMin: null, tMax: null, count: 0 };
            }
            return {
                id: j.id, name: j.name,
                min: r.min, max: r.max, rom: r.max - r.min,
                mean: r.sum / r.count,
                tMin: r.tMin, tMax: r.tMax, count: r.count
            };
        });
    }

    function renderRomReport() {
        const sel = document.getElementById('rom-scope-select');
        const scope = sel ? sel.value : 'all';
        const frames = _getRomScopeFrames(scope);
        const data = computeROM(frames);
        _lastRomData = data;

        const rowsHtml = data.map(d => {
            if (d.count === 0) {
                return `<tr><td>${d.name}</td><td colspan="5" style="color:#8b949e">データなし</td></tr>`;
            }
            return `<tr>
                <td>${d.name}</td>
                <td>${d.min.toFixed(1)}°</td>
                <td>${d.max.toFixed(1)}°</td>
                <td class="rom-highlight">${d.rom.toFixed(1)}°</td>
                <td>${d.mean.toFixed(1)}°</td>
                <td>${_romFmtTime(d.tMin)} / ${_romFmtTime(d.tMax)}</td>
            </tr>`;
        }).join('');

        const table = document.getElementById('rom-table');
        table.innerHTML =
            `<thead><tr><th>関節</th><th>最小</th><th>最大</th><th>ROM</th><th>平均</th><th>最小/最大 時刻</th></tr></thead>` +
            `<tbody>${rowsHtml}</tbody>`;

        const status = document.getElementById('rom-status');
        if (status) status.textContent = `${frames.length} フレームを集計`;
    }

    function exportRomCSV() {
        if (!_lastRomData) return;
        const lines = ['関節,最小(deg),最大(deg),ROM(deg),平均(deg),最小発生時刻(s),最大発生時刻(s),有効フレーム数'];
        _lastRomData.forEach(d => {
            lines.push([
                d.name,
                d.min !== null ? d.min.toFixed(2) : '',
                d.max !== null ? d.max.toFixed(2) : '',
                d.rom !== null ? d.rom.toFixed(2) : '',
                d.mean !== null ? d.mean.toFixed(2) : '',
                d.tMin !== null ? d.tMin.toFixed(3) : '',
                d.tMax !== null ? d.tMax.toFixed(3) : '',
                d.count
            ].join(','));
        });
        const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: 'text/csv;charset=utf-8;' });
        _download(blob, `rom_report_${state.currentFileName || 'data'}.csv`);
    }

    /* ============================================================
    実寸(cm)キャリブレーション ／ 距離計測
    ・動画上で2点クリック → 実測距離(cm)を入力 → px/cm 比を state.calibration に保持
    ・以後「距離を計測」で任意の2点間を実寸換算して表示できる
    ・normalized(0〜1)座標 → video ネイティブ解像度のピクセル距離に変換してから
      px/cm を算出するため、表示倍率（CSSサイズ）に依存しない
    ============================================================ */
    let _twoPointCapture = null; // { points: [{x,y}], onComplete, markers: [] }

    function _calibGetVideoRenderRect() {
        const canvas = document.getElementById('canvas-2d');
        if (!canvas || !video.videoWidth || !video.videoHeight) return null;
        const dispW = canvas.clientWidth;
        const dispH = canvas.clientHeight;
        const vidW  = video.videoWidth;
        const vidH  = video.videoHeight;
        const scale = Math.min(dispW / vidW, dispH / vidH);
        const renderW = vidW * scale;
        const renderH = vidH * scale;
        const offsetX = (dispW - renderW) / 2;
        const offsetY = (dispH - renderH) / 2;
        return { offsetX, offsetY, renderW, renderH, scale };
    }

    // クリック座標 → 正規化座標(0〜1)。映像エリア外なら null
    function _calibClientToNorm(clientX, clientY) {
        const layer = document.getElementById('calib-click-layer');
        const rect = layer.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const vr = _calibGetVideoRenderRect();
        if (!vr) return null;
        const normX = (localX - vr.offsetX) / vr.renderW;
        const normY = (localY - vr.offsetY) / vr.renderH;
        if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return null;
        return { x: normX, y: normY, clientX, clientY };
    }

    // 正規化座標2点間の距離を、動画ネイティブ解像度のピクセル単位で返す
    function _calibPxDistanceNative(p1, p2) {
        const dx = (p2.x - p1.x) * video.videoWidth;
        const dy = (p2.y - p1.y) * video.videoHeight;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function _calibClearMarkers() {
        document.querySelectorAll('.calib-point-marker, .calib-point-line').forEach(el => el.remove());
    }

    function _calibDrawMarker(clientX, clientY) {
        const box = document.getElementById('calib-click-layer').parentElement;
        const rect = box.getBoundingClientRect();
        const marker = document.createElement('div');
        marker.className = 'calib-point-marker';
        marker.style.left = (clientX - rect.left) + 'px';
        marker.style.top  = (clientY - rect.top)  + 'px';
        box.appendChild(marker);
    }

    function _calibDrawLine(p1Client, p2Client) {
        const box = document.getElementById('calib-click-layer').parentElement;
        const rect = box.getBoundingClientRect();
        const x1 = p1Client.clientX - rect.left, y1 = p1Client.clientY - rect.top;
        const x2 = p2Client.clientX - rect.left, y2 = p2Client.clientY - rect.top;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        const line = document.createElement('div');
        line.className = 'calib-point-line';
        line.style.left = x1 + 'px';
        line.style.top = y1 + 'px';
        line.style.width = len + 'px';
        line.style.transform = `rotate(${angle}deg)`;
        box.appendChild(line);
    }

    function _handleCalibClick(e) {
        if (!_twoPointCapture) return;
        const norm = _calibClientToNorm(e.clientX, e.clientY);
        if (!norm) return; // 映像エリア外は無視

        _twoPointCapture.points.push(norm);
        _calibDrawMarker(e.clientX, e.clientY);

        if (_twoPointCapture.points.length === 1) {
            document.getElementById('calib-banner-text').textContent = '基準点2点目をクリックしてください';
        } else if (_twoPointCapture.points.length === 2) {
            _calibDrawLine(_twoPointCapture.points[0], _twoPointCapture.points[1]);
            const layer = document.getElementById('calib-click-layer');
            layer.style.display = 'none';
            document.getElementById('calib-banner').style.display = 'none';
            layer.removeEventListener('click', _handleCalibClick);
            const cb = _twoPointCapture.onComplete;
            const pts = _twoPointCapture.points;
            _twoPointCapture = null;
            cb(pts[0], pts[1]);
        }
    }

    function _startTwoPointCapture(bannerText, onComplete) {
        if (!video.videoWidth) {
            alert('動画が読み込まれていません。先に動画を開いてください。');
            return;
        }
        _calibClearMarkers();
        _twoPointCapture = { points: [], onComplete };
        const layer = document.getElementById('calib-click-layer');
        layer.style.display = 'block';
        layer.addEventListener('click', _handleCalibClick);
        document.getElementById('calib-banner-text').textContent = bannerText;
        document.getElementById('calib-banner').style.display = 'flex';
    }

    function cancelTwoPointCapture() {
        const layer = document.getElementById('calib-click-layer');
        layer.style.display = 'none';
        layer.removeEventListener('click', _handleCalibClick);
        document.getElementById('calib-banner').style.display = 'none';
        document.getElementById('calib-input-modal').classList.remove('open');
        _calibClearMarkers();
        _twoPointCapture = null;
        _pendingCalibPoints = null;
    }

    /* --- キャリブレーション --- */
    let _pendingCalibPoints = null;

    function startCalibration() {
        _startTwoPointCapture('基準点1点目をクリックしてください（実際の長さが分かっている2点）', (p1, p2) => {
            _pendingCalibPoints = [p1, p2];
            document.getElementById('calib-cm-input').value = '';
            document.getElementById('calib-status').textContent = '';
            document.getElementById('calib-input-modal').classList.add('open');
        });
    }

    function confirmCalibrationInput() {
        const cmVal = parseFloat(document.getElementById('calib-cm-input').value);
        if (!_pendingCalibPoints || !cmVal || cmVal <= 0) {
            document.getElementById('calib-status').textContent = '正しい数値（cm）を入力してください';
            return;
        }
        const [p1, p2] = _pendingCalibPoints;
        const pxDistance = _calibPxDistanceNative(p1, p2);
        if (pxDistance < 1) {
            document.getElementById('calib-status').textContent = '2点が近すぎます。やり直してください';
            return;
        }
        state.calibration = {
            p1, p2, realCm: cmVal, pxDistance,
            pxPerCm: pxDistance / cmVal,
            videoWidth: video.videoWidth, videoHeight: video.videoHeight,
            calibratedAt: Date.now()
        };
        document.getElementById('calib-input-modal').classList.remove('open');
        _calibClearMarkers();
        _pendingCalibPoints = null;
        _updateCalibBadge();
        alert(`キャリブレーション完了：1cm ≈ ${state.calibration.pxPerCm.toFixed(2)}px（動画解像度基準）\n\n※2D画像上の比例換算による推定値です。カメラの透視投影や奥行きの違いにより誤差が生じる場合があります。`);
    }

    /* --- 距離計測（キャリブレーション済みの場合のみ） --- */
    function startMeasurement() {
        if (!state.calibration) {
            alert('先に「実寸(cm)キャリブレーション」を実行してください。');
            return;
        }
        if (state.calibration.videoWidth !== video.videoWidth || state.calibration.videoHeight !== video.videoHeight) {
            const proceed = confirm('現在の動画はキャリブレーション時と解像度が異なります。精度が落ちる可能性がありますが続行しますか？');
            if (!proceed) return;
        }
        _startTwoPointCapture('計測点1点目をクリックしてください', (p1, p2) => {
            const pxDistance = _calibPxDistanceNative(p1, p2);
            const cm = pxDistance / state.calibration.pxPerCm;
            document.getElementById('measure-result-value').textContent = `${cm.toFixed(1)} cm`;
            document.getElementById('measure-result-modal').classList.add('open');
            _calibClearMarkers();
        });
    }

    function closeMeasureResult() {
        document.getElementById('measure-result-modal').classList.remove('open');
    }

    /* ============================================================
    exportJSON — v14.1: Inline Worker + ArrayBuffer Transferable
    ・Worker内で Blob を作り .arrayBuffer() を転送（Transferable）
    ・postMessage で巨大文字列を渡すとブラウザが内部コピーを作り
      瞬間メモリが2倍になる問題を根絶する。
    ============================================================ */
    const _EXPORT_WORKER_SRC = `
self.onmessage = async function(e) {
    const { meta, chunks } = e.data;
    const parts = [];
    parts.push('{"appName":' + JSON.stringify(meta.appName) +
               ',"version":' + JSON.stringify(meta.version) +
               ',"videoFile":' + JSON.stringify(meta.videoFile) +
               ',"history":[');
    let first = true;
    for (const chunk of chunks) {
        const str = JSON.stringify(chunk);
        self.postMessage({ type: 'progress', done: chunk.length });
        if (!first) parts.push(',');
        parts.push(str.slice(1, str.length - 1));
        first = false;
    }
    parts.push(']}');
    // ★ 文字列を postMessage で返すとブラウザが内部コピーを作りメモリが倍増する。
    //   Worker側で直接 Blob → ArrayBuffer に変換し、Transferable として送る。
    const outBlob = new Blob(parts, { type: 'application/json' });
    const buffer  = await outBlob.arrayBuffer();
    self.postMessage({ type: 'done', buffer }, [buffer]); // [buffer] = transfer list
};
`;

    // ★ 修正2: 連打によるWorker多重生成を防ぐフラグ
    let _exportWorkerRunning = false;

    // ★ 修正4: Promise を返すよう変更 → exportAndClearHistory が完了を待てる
    function exportJSON() {
        if (state.history.length === 0) {
            alert("保存するデータがありません。");
            return Promise.reject(new Error('no-history'));
        }

        _showUnsavedBadge(false); // ★ 修正: 保存起動時にバッジを消す
        if (_exportWorkerRunning) {
            alert("保存処理が進行中です。しばらくお待ちください。");
            return Promise.reject(new Error('export-running'));
        }

        const CHUNK = 2000;
        const hist  = state.history.slice(); // ★ スナップショット（書き出し中の変更を隔離）
        const chunks = [];
        for (let i = 0; i < hist.length; i += CHUNK) chunks.push(hist.slice(i, i + CHUNK));

        return new Promise((resolve, reject) => {
            let worker = null;
            let wUrl   = null;

            const cleanup = () => {
                try { worker?.terminate(); } catch (_) {}
                if (wUrl) { try { URL.revokeObjectURL(wUrl); } catch (_) {} }
                _exportWorkerRunning = false;
            };

            try {
                const workerBlob = new Blob([_EXPORT_WORKER_SRC], { type: 'text/javascript' });
                wUrl   = URL.createObjectURL(workerBlob);
                worker = new Worker(wUrl);
                _exportWorkerRunning = true;
            } catch (e) {
                reject(e); return;
            }

            const total = hist.length;
            let done = 0;

            worker.onmessage = (ev) => {
                if (ev.data.type === 'progress') {
                    done += ev.data.done;
                    console.info(`[exportJSON] ${Math.round(done / total * 100)}%`);
                } else if (ev.data.type === 'done') {
                    const outBlob = new Blob([ev.data.buffer], { type: 'application/json' });
                    _download(outBlob, `analysis_${Date.now()}.json`);
                    console.info('[exportJSON] ✅ 完了');
                    cleanup();
                    resolve();
                }
            };

            worker.onerror = (err) => {
                console.error('Export worker error:', err);
                // ★ フォールバック: メインスレッドで直接シリアライズ
                try {
                    const data = { appName: "KANSETSU-SCOPE", version: "v14.1",
                                   videoFile: state.currentFileName || "unknown", history: hist };
                    _download(new Blob([JSON.stringify(data)], { type: 'application/json' }),
                              `analysis_${Date.now()}.json`);
                    cleanup();
                    resolve(); // フォールバック成功もresolve
                } catch (e2) {
                    cleanup();
                    reject(e2);
                }
            };

            worker.postMessage({
                meta: { appName: "KANSETSU-SCOPE", version: "v14.1",
                        videoFile: state.currentFileName || "unknown" },
                chunks
            });
        });
    }

    /* ============================================================
    JSON Import: スキーマ検証
    ・不正/巨大/型不整合なデータを state へ部分的に投入しないよう、
      「検証 → 正規化 → 一括代入」の順で行う（途中で失敗したら state 変更なし）
    ============================================================ */
    const _IMPORT_MAX_FRAMES = 50000; // 安全弁。maxHistory(18000)より余裕を持たせた絶対上限

    function _isFiniteNum(v) {
        return typeof v === 'number' && Number.isFinite(v);
    }

    // landmarks/world 配列の検証: 各要素は null か {x,y,(z,)visibility}
    function _validateLandmarkArray(arr, requireZ) {
        if (!Array.isArray(arr)) return false;
        for (const p of arr) {
            if (p === null || p === undefined) continue;
            if (typeof p !== 'object') return false;
            if (!_isFiniteNum(p.x) || !_isFiniteNum(p.y)) return false;
            if (requireZ && !_isFiniteNum(p.z)) return false;
            if (p.visibility !== undefined && !_isFiniteNum(p.visibility)) return false;
        }
        return true;
    }

    function _validateAngles(angles) {
        if (angles === null || typeof angles !== 'object' || Array.isArray(angles)) return false;
        for (const key in angles) {
            const v = angles[key];
            if (v !== null && v !== undefined && !_isFiniteNum(v)) return false;
        }
        return true;
    }

    // データ全体を検証し { ok, errors } を返す。state には一切触れない（副作用なし）
    function validateImportedData(data) {
        const errors = [];
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            errors.push('JSONのルートがオブジェクトではありません');
            return { ok: false, errors };
        }
        if (!Array.isArray(data.history)) {
            errors.push('history が配列ではありません');
            return { ok: false, errors };
        }
        if (data.history.length === 0) {
            errors.push('history が空です');
            return { ok: false, errors };
        }
        if (data.history.length > _IMPORT_MAX_FRAMES) {
            errors.push(`フレーム数が多すぎます（${data.history.length}件 / 上限${_IMPORT_MAX_FRAMES}件）`);
            return { ok: false, errors };
        }

        // 全フレームを検証（最初の異常で打ち切り、詳細をエラーに含める）
        for (let i = 0; i < data.history.length; i++) {
            const h = data.history[i];
            if (h === null || typeof h !== 'object') {
                errors.push(`フレーム${i}: オブジェクトではありません`);
                break;
            }
            const t = h.t ?? h.time;
            if (!_isFiniteNum(t) || t < 0) {
                errors.push(`フレーム${i}: t（時刻）が不正な数値です`);
                break;
            }
            const l = h.l ?? h.landmarks ?? [];
            const w = h.w ?? h.world ?? [];
            const a = h.a ?? h.angles ?? {};
            if (!_validateLandmarkArray(l, false)) {
                errors.push(`フレーム${i}: l(landmarks) の座標が不正です`);
                break;
            }
            if (!_validateLandmarkArray(w, true)) {
                errors.push(`フレーム${i}: w(world) の座標が不正です`);
                break;
            }
            if (!_validateAngles(a)) {
                errors.push(`フレーム${i}: a(angles) の値が不正です`);
                break;
            }
        }

        return { ok: errors.length === 0, errors };
    }

    // 検証済みデータを正規化。t 昇順にソートして返す（history のソート不変条件を維持）
    function normalizeImportedData(data) {
        const frames = data.history.map(h => ({
            t: h.t ?? h.time ?? 0,
            l: h.l ?? h.landmarks ?? [],
            w: h.w ?? h.world ?? [],
            a: h.a ?? h.angles ?? {}
        }));
        frames.sort((a, b) => a.t - b.t);
        return frames;
    }

    function importJSON(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);

                const { ok, errors } = validateImportedData(data);
                if (!ok) {
                    alert("読み込みエラー: JSONの形式が不正です。\n" + errors.slice(0, 3).join('\n'));
                    console.error('[importJSON] validation failed:', errors);
                    return; // ★ 検証NG時は state を一切変更しない（部分投入を防止）
                }

                const frames = normalizeImportedData(data);

                // ★ 検証・正規化が完了してから一括代入
                state.history = frames;
                // ★ Bug-J fix: インポート後に stale な EMA / lastValidFrame をクリア
                state.smoothedLandmarks = null;
                state.smoothedWorldLandmarks = null;
                state.lastValidFrame = null;
                state.lastReliableLandmarks = null;
                state.isEmaResetTriggered = true;
                // ★ 修正: インポート後にメモリバッジも更新
                _updateMemoryBadge(state.history.length / state.maxHistory);
                alert(`${state.history.length}フレーム分のデータを読み込みました。`);
                updateUI(); refreshJointUI();
            } catch (err) {
                alert("読み込みエラー: ファイル形式が正しくありません。");
                console.error(err);
            } finally {
                // ★ 修正: 同じファイルを再選択できるよう input value をリセット
                if (event.target) event.target.value = '';
            }
        };
        reader.readAsText(file);
    }

    // expose importJSON for header input
    window.importJSON = importJSON;

    /* ============================================================
    18. Segment Save / Load
    ============================================================ */
    const SEG_COLORS = ['#58a6ff','#ff7b72','#3fb950','#f1c40f','#bc8cff','#ff9800'];

    function saveSegment() {
        if (state.repeatA === null || state.repeatB === null) {
            alert('A/B点を両方セットしてから保存してください');
            return;
        }
        const name = `区間${state.segments.length + 1}`;
        const color = SEG_COLORS[state.segments.length % SEG_COLORS.length];
        state.segments.push({ id: Date.now(), name, a: state.repeatA, b: state.repeatB, color });
        renderSegChips();
    }

    function loadSegment(id) {
        const seg = state.segments.find(s => s.id === id);
        if (!seg) return;
        state.repeatA = seg.a;
        state.repeatB = seg.b;
        updateHandleOnly();
        // セクションの先頭にシーク
        seekAndDetect(seg.a);
    }

    // ★ Bug3修正: deleteSegment が未定義だったため追加
    // ★ 修正: 削除した区間が現在の A/B と一致したら A/B もクリア
    function deleteSegment(id) {
        const target = state.segments.find(s => s.id === id);
        state.segments = state.segments.filter(s => s.id !== id);
        if (target && state.repeatA === target.a && state.repeatB === target.b) {
            state.repeatA = null;
            state.repeatB = null;
            updateHandleOnly();
        }
        renderSegChips();
    }

    function renderSegChips() {
        const row = document.getElementById('seg-row');
        if (!row) return;
        row.innerHTML = '';

        if (state.segments.length === 0) {
            row.style.display = 'none';   // ★ 区間なし → 枠ごと非表示
            return;
        }

        row.style.display = '';           // ★ 区間あり → 枠を表示

        state.segments.forEach(seg => {
            const chip = document.createElement('div');
            chip.className = 'seg-chip';
            chip.style.color = seg.color;
            chip.style.borderColor = seg.color;

            const fmtA = formatTime(seg.a) + '.' + String(Math.round((seg.a % 1) * 10)).padStart(1,'0');
            const fmtB = formatTime(seg.b) + '.' + String(Math.round((seg.b % 1) * 10)).padStart(1,'0');

            chip.innerHTML = `
                <span>${seg.name}</span>
                <span class="seg-time">${fmtA}–${fmtB}</span>
                <span class="seg-del" title="削除">✕</span>
            `;
            chip.onclick = () => loadSegment(seg.id);
            chip.querySelector('.seg-del').onclick = e => {
                e.stopPropagation();
                deleteSegment(seg.id);
            };
            row.appendChild(chip);
        });
    }

    /* ============================================================
    データメニュー
    ============================================================ */
    function toggleDataMenu() {
        _updateCalibBadge();
        document.getElementById('hd-data-menu').classList.toggle('open');
    }
    function closeDataMenu() {
        document.getElementById('hd-data-menu').classList.remove('open');
    }
    // キャリブレーション状態バッジ（未設定 / 設定済み）を更新
    function _updateCalibBadge() {
        const badge = document.getElementById('calib-status-badge');
        if (!badge) return;
        if (state.calibration) {
            badge.textContent = `設定済み（1cm≈${state.calibration.pxPerCm.toFixed(1)}px）`;
            badge.classList.add('done');
        } else {
            badge.textContent = '未設定';
            badge.classList.remove('done');
        }
    }
    // メニュー外クリックで閉じる
    document.addEventListener('click', e => {
        const wrap = document.getElementById('hd-data-wrap');
        if (wrap && !wrap.contains(e.target)) closeDataMenu();
    });

    /* ============================================================
    Export Modal
    ============================================================ */
    function openExportModal() {
        const fmt = t => t === null ? '--:--' : formatTime(t);
        const aEl = document.getElementById('exp-ab-a');
        const bEl = document.getElementById('exp-ab-b');
        if (aEl) aEl.textContent = fmt(state.repeatA);
        if (bEl) bEl.textContent = fmt(state.repeatB);
        document.getElementById('export-modal').classList.add('open');
    }
    
    function closeExportModal() {
        // ★ Bug-R fix: 録画中にモーダルを閉じると録画がゾンビ化する問題を防ぐ
        // ★ 修正: 2D 録画中も confirm してから閉じる（3Dと同じロジックの順序を修正）
        if (_rec3dRunning) {
            const force = confirm('3D動画を録画中です。中断して閉じますか？');
            if (!force) return; // ユーザーが「キャンセル」→ モーダルを閉じない
            stopRecording3D();
        }
        if (typeof _rec2dRunning !== 'undefined' && _rec2dRunning) {
            const force = confirm('2D動画を録画中です。中断して閉じますか？');
            if (!force) return;
            stopRecording2D();
        }
        document.getElementById('export-modal').classList.remove('open');
    }

    function switchExpTab(tab) {
        const tabs   = ['gif','png','3d'];
        const labels = document.querySelectorAll('.exp-tab');
        labels.forEach((el, i) => el.classList.toggle('active', tabs[i] === tab));
        document.querySelectorAll('.exp-panel').forEach(el => el.classList.remove('active'));
        const panel = document.getElementById(`exp-panel-${tab}`);
        if (panel) panel.classList.add('active');
    }

    /* ----- 2D 録画 ----- */
    let _rec2d = null, _rec2dChunks = [], _rec2dRunning = false;
    let _rec2dFrameCount = 0; // ★ ストリームパルス維持用カウンタ

    function toggleRecording2D() {
        _rec2dRunning ? stopRecording2D() : startRecording2D();
    }

    function startRecording2D() {
        if (_rec2dRunning) return;                      // 二重起動防止
        state.worldOrigin = null;
        state.isEmaResetTriggered = true;

        const W = state.baseWidth  || 1280;
        const H = state.baseHeight || 720;

        const offscreen = document.createElement('canvas');
        offscreen.width  = W;
        offscreen.height = H;
        const octx = offscreen.getContext('2d');

        const src2d = document.getElementById('canvas-2d');

        // ★ captureStream を変数に保持して後で track を止められるようにする
        _rec2dStream = offscreen.captureStream(30);

        // ★ 修正1: 無音 AudioTrack を追加（QuickTimeが音声なしMP4を破損扱いする問題を回避）
        const _2dAudio = _createSilentAudioTrack();
        if (_2dAudio?.track) _rec2dStream.addTrack(_2dAudio.track);

        _rec2dRunning = true;
        updateStatusPills();
        _rec2dFrameCount = 0; // ★ 毎回リセット（連続録画で前回値が残らないよう）
        const loop = () => {
            if (!_rec2dRunning) { _rec2dRaf = 0; return; }
            octx.drawImage(video, 0, 0, W, H);
            if (src2d) octx.drawImage(src2d, 0, 0, W, H);
            // ★ 改善: 角度グラフ（graph-overlay）も合成に含める
            // graph-overlay の内部解像度は画面表示サイズ（view-box基準）なので、
            // オフスクリーン(W,H)にそのまま等倍描画すると歪む。下部20%帯に収める。
            const srcGraph = document.getElementById('graph-overlay');
            if (srcGraph && srcGraph.width > 0 && srcGraph.height > 0) {
                octx.drawImage(srcGraph, 0, H * 0.8, W, H * 0.2);
            }
            // ★ 修正4: 骨格更新がなくてもキャンバスに微小変化を加えてストリームパルスを維持
            //   フレーム0固定バグ（MediaRecorder が壊れたヘッダーを書く）を防ぐ
            _rec2dFrameCount++;
            octx.save();
            octx.font = '10px monospace';
            octx.fillStyle = 'rgba(0,0,0,0.01)'; // 実質透明だが描画関数は実行される
            octx.fillText(_rec2dFrameCount, W - 1, H - 1);
            octx.restore();
            _rec2dRaf = requestAnimationFrame(loop);
        };
        _rec2dRaf = requestAnimationFrame(loop);

        const mimeType = _getBestRecordingMimeType(); // ★ Safari対応: VP9→VP8→WebM→MP4 の順で自動選択

        _rec2d = new MediaRecorder(_rec2dStream, mimeType ? { mimeType } : {});
        _rec2dChunks = [];

        _rec2d.ondataavailable = e => { if (e.data.size > 0) _rec2dChunks.push(e.data); };

        _rec2d.onstop = () => {
            // ★ rAF と stream track を確実に解放
            if (_rec2dRaf) { cancelAnimationFrame(_rec2dRaf); _rec2dRaf = 0; }
            stopMediaStream(_rec2dStream); _rec2dStream = null;
            // ★ 修正1: 無音 AudioContext を閉じてリソース解放
            if (_2dAudio?.audioCtx) {
                try { _2dAudio.audioCtx.close(); } catch (_) {}
            }
            _rec2dRunning = false;
            if (_rec2dChunks.length > 0) {
                // ★ 修正②: onstop 時点での実際の mimeType を参照（Safari で mp4 録画された場合も正しく拡張子が付く）
                const actualMime2d = _rec2d?.mimeType || mimeType || 'video/webm';
                const blob = new Blob(_rec2dChunks, { type: actualMime2d });
                const ext2d = actualMime2d.includes('mp4') ? 'mp4' : 'webm';
                _download(blob, `ks_2d_${Date.now()}.${ext2d}`);
            }
            _rec2dChunks = [];
            _setRec2dUI(false, '✅ 保存しました');
        };

        _rec2d.onerror = (ev) => {
            console.error('MediaRecorder 2D error:', ev.error);
            // ★ エラー時も必ずクリーンアップ
            if (_rec2dRaf) { cancelAnimationFrame(_rec2dRaf); _rec2dRaf = 0; }
            stopMediaStream(_rec2dStream); _rec2dStream = null;
            // ★ R-3: onerror でも AudioContext を解放（onstop は呼ばれない）
            if (_2dAudio?.audioCtx) { try { _2dAudio.audioCtx.close(); } catch (_) {} }
            _rec2dRunning = false;
            _rec2dChunks = [];
            _setRec2dUI(false, '⚠️ 録画エラー');
        };

        _rec2d.start(100);
        _setRec2dUI(true);
        if (video.paused) togglePlay();
    }

    function stopRecording2D() {
        if (!_rec2dRunning) return;   // ★ Bug-3 fix: 二重呼び出し防止
        _rec2dRunning = false;        // ★ 先にフラグを落として rAF ループを止める
        updateStatusPills();

        if (_rec2dRaf) { cancelAnimationFrame(_rec2dRaf); _rec2dRaf = 0; }

        if (_rec2d) {
            try {
                if (_rec2d.state !== 'inactive') _rec2d.stop(); // onstop 内で stream 解放
            } catch (e) {
                // ★ Bug-3 fix: inactive に stop() を呼ぶと DOMException が飛ぶ → ここで確実に後始末
                console.warn('[KS] MediaRecorder 2D stop exception:', e);
                stopMediaStream(_rec2dStream); _rec2dStream = null;
            }
        } else {
            stopMediaStream(_rec2dStream); _rec2dStream = null;
        }

        _setRec2dUI(false, '保存中...');
    }

    function _setRec2dUI(recording, statusMsg = '') {
        // インライン REC ボタン（再生バー横）
        const inlineBtn = document.getElementById('btn-rec-inline');
        if (inlineBtn) inlineBtn.classList.toggle('active', recording);

        // モーダル内ステータス（モーダルが開いていれば更新）
        const sts = document.getElementById('rec2d-status');
        if (sts) {
            sts.textContent = recording ? '録画中...' : statusMsg;
            sts.className = 'exp-status ' + (recording ? 'recording' : 'done');
        }
    }

    /* ----- 3D 録画 ----- */
    let _rec3d = null, _rec3dChunks = [], _rec3dRunning = false;
    let _rec3dFrameCount = 0; // ★ ストリームパルス維持用カウンタ

    function toggleRecording3D() {
            _rec3dRunning ? stopRecording3D() : startRecording3D();
        }

        // --- 3D Recording UI State ---
    function _setRec3dUI(recording, statusMsg = '') {
        const btn = document.getElementById('btn-rec3d');
        if (btn) {
            btn.classList.toggle('recording', recording);
            btn.classList.toggle('idle', !recording);
            // ★ v14.2: textContent は内部の span/icon を破壊するため、各要素を個別更新
            const dot   = document.getElementById('rec3d-dot');
            const label = document.getElementById('rec3d-label');
            if (dot)   dot.style.display   = recording ? 'inline-block' : 'none';
            if (label) label.innerHTML = recording
                ? '録画中...'
                : '<i class="fas fa-circle" style="color:#ff4444"></i> 録画開始';
        }

        const sts = document.getElementById('rec3d-status');
        if (sts) {
            sts.textContent = recording ? '● REC' : (statusMsg || '');
            sts.className = 'exp-status ' + (recording ? 'recording' : (statusMsg ? 'done' : ''));
        }
    }

    function startRecording3D() {
        if (_rec3dRunning) return;                      // 二重起動防止
        const threeCanvas = document.querySelector('#three-container canvas');
        if (!threeCanvas) { alert('Three.js canvas が見つかりません'); return; }

        state.worldOrigin = null;
        state.isEmaResetTriggered = true;

        const oldBg = scene.background;
        scene.background = new THREE.Color(0x000000);

        const W = state.baseWidth  || video.videoWidth  || 1280;
        const H = state.baseHeight || video.videoHeight || 720;

        const off = document.createElement('canvas');
        off.width  = W;
        off.height = H;
        const octx = off.getContext('2d');

        // ★ captureStream を変数に保持
        _rec3dStream = off.captureStream(30);

        // ★ 修正1: 無音 AudioTrack を追加（QuickTimeが音声なしMP4を破損扱いする問題を回避）
        const _3dAudio = _createSilentAudioTrack();
        if (_3dAudio?.track) _rec3dStream.addTrack(_3dAudio.track);

        _rec3dRunning = true;
        updateStatusPills();
        _rec3dFrameCount = 0; // ★ 毎回リセット（連続録画で前回値が残らないよう）
        const loop = () => {
            if (!_rec3dRunning) { _rec3dRaf = 0; return; }
            renderer.render(scene, camera);
            octx.drawImage(threeCanvas, 0, 0, W, H);
            // ★ 修正4: ストリームパルス維持（フレームレート0の壊れたヘッダー防止）
            _rec3dFrameCount++;
            octx.save();
            octx.font = '10px monospace';
            octx.fillStyle = 'rgba(0,0,0,0.01)';
            octx.fillText(_rec3dFrameCount, W - 1, H - 1);
            octx.restore();
            _rec3dRaf = requestAnimationFrame(loop);
        };
        _rec3dRaf = requestAnimationFrame(loop);

        const mimeType = _getBestRecordingMimeType(); // ★ Safari対応: VP9→VP8→WebM→MP4 の順で自動選択

        _rec3d = new MediaRecorder(_rec3dStream, mimeType ? { mimeType } : {});
        _rec3dChunks = [];

        _rec3d.ondataavailable = e => { if (e.data.size > 0) _rec3dChunks.push(e.data); };

        _rec3d.onstop = () => {
            // ★ rAF と stream track を確実に解放
            if (_rec3dRaf) { cancelAnimationFrame(_rec3dRaf); _rec3dRaf = 0; }
            stopMediaStream(_rec3dStream); _rec3dStream = null;
            // ★ 修正1: 無音 AudioContext を閉じてリソース解放
            if (_3dAudio?.audioCtx) {
                try { _3dAudio.audioCtx.close(); } catch (_) {}
            }
            scene.background = oldBg;                  // ★ 背景色を復元
            _rec3dRunning = false;
            updateStatusPills();

            if (_rec3dChunks.length > 0) {
                // ★ 修正②: onstop 時点での実際の mimeType を参照
                const actualMime3d = _rec3d?.mimeType || mimeType || 'video/webm';
                const blob = new Blob(_rec3dChunks, { type: actualMime3d });
                const ext3d = actualMime3d.includes('mp4') ? 'mp4' : 'webm';
                _download(blob, `ks_3d_${Date.now()}.${ext3d}`);
            }
            _rec3dChunks = [];
            _setRec3dUI(false, '✅ 保存しました');
        };

        _rec3d.onerror = (ev) => {
            console.error('MediaRecorder 3D error:', ev.error);
            // ★ エラー時も必ずクリーンアップ＋背景復元
            if (_rec3dRaf) { cancelAnimationFrame(_rec3dRaf); _rec3dRaf = 0; }
            stopMediaStream(_rec3dStream); _rec3dStream = null;
            // ★ R-3: onerror でも AudioContext を解放（onstop は呼ばれない）
            if (_3dAudio?.audioCtx) { try { _3dAudio.audioCtx.close(); } catch (_) {} }
            scene.background = oldBg;
            _rec3dRunning = false;
            _rec3dChunks = [];
            _setRec3dUI(false, '⚠️ 録画エラー');
        };

        _rec3d.start(100);
        _setRec3dUI(true);
        if (video.paused) togglePlay();
    }

    function stopRecording3D() {
        if (!_rec3dRunning) return;   // ★ Bug-3 fix: 二重呼び出し防止
        _rec3dRunning = false;        // ★ 先にフラグを落として rAF ループを止める
        updateStatusPills();

        if (_rec3dRaf) { cancelAnimationFrame(_rec3dRaf); _rec3dRaf = 0; }

        if (_rec3d) {
            try {
                if (_rec3d.state !== 'inactive') _rec3d.stop(); // onstop 内で stream 解放
            } catch (e) {
                // ★ Bug-3 fix: inactive に stop() を呼ぶと DOMException が飛ぶ → ここで確実に後始末
                console.warn('[KS] MediaRecorder 3D stop exception:', e);
                stopMediaStream(_rec3dStream); _rec3dStream = null;
            }
        } else {
            stopMediaStream(_rec3dStream); _rec3dStream = null;
        }

        _setRec3dUI(false, '保存中...');
    }
    // --- PNG Export (動画フレーム + 2D骨格の合成出力) ---
    // ★ 修正: 以前は canvas-2d のみを PNG 出力していたため、背景が透明だった。
        //   2D 録画と同じように video + canvas-2d をオフスクリーンで合成して出力する。
        function exportPNG() {
            const canvas = document.getElementById('canvas-2d');
            if (!canvas) {
                alert('2D canvas が見つかりません');
                return;
            }

            // ★ 修正: 動画フレームのサイズを使う。動画未読み込み時は canvas-2d のみを出力。
            const W = state.baseWidth  || video.videoWidth  || canvas.width;
            const H = state.baseHeight || video.videoHeight || canvas.height;

            const off = document.createElement('canvas');
            off.width  = W;
            off.height = H;
            const octx = off.getContext('2d');

            // 動画フレームを描画
            try {
                if (video.videoWidth > 0) {
                    octx.drawImage(video, 0, 0, W, H);
                }
            } catch (e) {
                console.warn('PNG: video drawImage failed (may be tainted):', e);
            }
            // 骨格を重ねる
            octx.drawImage(canvas, 0, 0, W, H);
            // ★ 改善: 角度グラフも下部20%帯に合成
            const srcGraphPng = document.getElementById('graph-overlay');
            if (srcGraphPng && srcGraphPng.width > 0 && srcGraphPng.height > 0) {
                octx.drawImage(srcGraphPng, 0, H * 0.8, W, H * 0.2);
            }

            off.toBlob(blob => {
                if (!blob) {
                    alert('PNG の生成に失敗しました');
                    return;
                }
                _download(blob, `ks_${Date.now()}.png`);
                const pngStatus = document.getElementById('png-status');
                if (pngStatus) {
                    pngStatus.textContent = '✅ 保存しました';
                    pngStatus.className = 'exp-status done';
                }
            }, 'image/png');
        }

    /* ----- GIF 出力 ----- */
    async function exportGIF() {
        if (state.repeatA === null || state.repeatB === null) {
            alert('A/B 区間を設定してから生成してください'); return;
        }
        if (!state.history.length) { alert('解析データがありません'); return; }

        // ★ 修正3: 既に実行中なら二重起動をブロック
        if (_gifExportRunning) {
            alert('GIF生成が進行中です。完了をお待ちください。');
            return;
        }

        const sts  = document.getElementById('gif-status');
        const fill = document.getElementById('gif-bar-fill');
        const btn  = document.getElementById('btn-gif');
        const setProgress = (msg, pct, cls = 'working') => {
            sts.textContent = msg; sts.className = `exp-status ${cls}`;
            fill.style.width = pct + '%';
        };

        _gifExportRunning = true;
        btn.disabled = true;
        // ★ Bug1修正: 'export-overlay' は存在しない → モーダルは既に開いているので不要
        setProgress('gif.js を読み込み中...', 5);

        if (!window.GIF) {
            // ★ v14.2: try/catch で確実に早期リターン（.catch内のreturnは関数を抜けない）
            try {
                await new Promise((res, rej) => {
                    const s = document.createElement('script');
                    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js';
                    s.onload = res; s.onerror = rej;
                    document.head.appendChild(s);
                });
            } catch (_) {
                setProgress('❌ gif.js の読み込みに失敗しました', 0, 'recording');
                btn.disabled = false;
                _gifExportRunning = false; // ★ R-1: ロード失敗時にフラグを必ず解除
                return;
            }
        }

        const fps   = parseInt(document.getElementById('gif-fps').value);
        const gw    = parseInt(document.getElementById('gif-width').value);
        // ★ Bug-I fix: baseWidth が 0 のとき NaN になるのを防ぐ
        const aspectRatio = (state.baseWidth > 0 && state.baseHeight > 0)
            ? state.baseHeight / state.baseWidth : 9 / 16;
        const gh = Math.round(gw * aspectRatio);
        const ivl   = 1 / fps;
        const frames = state.history.filter(h => h.t >= state.repeatA && h.t <= state.repeatB);

        // fps でサンプリング
        // ★ 修正: while ループで next を追い越す — 高 fps でフレーム間隔が狭いときの
        //   取りこぼしを防ぐ。`if (f.t >= next) next += ivl` だとサンプリングジッターが起こる。
        const sampled = [];
        let next = state.repeatA;
        for (const f of frames) {
            if (f.t >= next) {
                sampled.push(f);
                while (next <= f.t) next += ivl;
            }
        }
        if (sampled.length < 2) {
            setProgress('❌ フレームが不足しています', 0, 'recording');
            btn.disabled = false;
            _gifExportRunning = false; // ★ 修正: early return でもロック解除
            return;
        }

        setProgress(`フレーム描画中 0 / ${sampled.length}`, 10);

        const oc  = document.createElement('canvas');
        oc.width = gw; oc.height = gh;
        const oct = oc.getContext('2d');

        // ★ Bug-T fix: CDN Worker を直接指定するとCORSでブロックされるため
        //   一度 fetch してBlobURL化してから渡す
        let _gifWorkerUrl = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
        let _gifWorkerBlob = null;
        try {
            const res  = await fetch(_gifWorkerUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            _gifWorkerBlob = new Blob([text], { type: 'application/javascript' });
            _gifWorkerUrl  = URL.createObjectURL(_gifWorkerBlob);
        } catch (e) {
            console.warn('[KS] GIF worker fetch failed, using direct URL as fallback:', e);
        }

        // ★ 修正3: _gifInstance に保持（中断・重複防止用）
        const gif = new window.GIF({
            workers: 2, quality: 10, width: gw, height: gh,
            workerScript: _gifWorkerUrl
        });
        _gifInstance = gif;

        for (let i = 0; i < sampled.length; i++) {
            oct.fillStyle = '#0d1117'; oct.fillRect(0, 0, gw, gh);
            const lm = sampled[i].l;
            if (lm) {
                POSE_CONNECTIONS.forEach(c => {
                    const p1 = lm[c.p[0]], p2 = lm[c.p[1]];
                    if (!p1 || !p2) return;
                    oct.strokeStyle = c.side === 'L' ? '#ff7b72' : c.side === 'R' ? '#58a6ff' : '#aaa';
                    oct.lineWidth = 2; oct.lineCap = 'round';
                    oct.beginPath();
                    oct.moveTo(p1.x * gw, p1.y * gh);
                    oct.lineTo(p2.x * gw, p2.y * gh);
                    oct.stroke();
                });
            }
            gif.addFrame(oc, { copy: true, delay: Math.round(1000 / fps) });
            if (i % 5 === 0) {
                setProgress(`フレーム描画中 ${i + 1} / ${sampled.length}`, 10 + (i / sampled.length) * 60);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        gif.on('progress', p => setProgress(`エンコード中 ${Math.round(p * 100)} %`, 70 + p * 29));
        gif.on('finished', blob => {
            _download(blob, `ks_${Date.now()}.gif`);
            setProgress('✅ GIF を保存しました', 100, 'done');
            btn.disabled = false;
            // ★ Bug-T fix: BlobURL を使い終わったら解放
            if (_gifWorkerBlob) {
                try { URL.revokeObjectURL(_gifWorkerUrl); } catch (_) {}
                _gifWorkerBlob = null;
            }
            // ★ 修正3: 完了時にフラグとインスタンスをクリア
            _gifExportRunning = false;
            _gifInstance = null;
        });

        gif.on('abort', () => {
            // ★ 修正3: abort() 呼び出し時のクリーンアップ
            setProgress('⏹ GIF 生成を中断しました', 0, 'done');
            btn.disabled = false;
            if (_gifWorkerBlob) {
                try { URL.revokeObjectURL(_gifWorkerUrl); } catch (_) {}
                _gifWorkerBlob = null;
            }
            _gifExportRunning = false;
            _gifInstance = null;
        });
        // ★ R-2: render 中に未捕捉例外が出てもフラグが残らないよう保護
        try {
            gif.render();
        } catch (e) {
            console.error('[KS] gif.render() failed:', e);
            setProgress('❌ GIF レンダリングエラー', 0, 'recording');
            btn.disabled = false;
            _gifExportRunning = false;
            _gifInstance = null;
        }
    }

   /* ------------------------------
        drawTextBlock (背景付きテキスト描画)
    ------------------------------ */
   function drawTextBlock(ctx, text, x, y, options = {}) {
        const {
            color      = "#ffffff",
            bg         = "rgba(0,0,0,0.5)",
            fontSize   = 14,
            padding    = 8,
            fontFamily = "sans-serif"
        } = options;

        ctx.save();
        ctx.globalAlpha = 1.0; // ★ v14.2d: 外側で alphaGraph(0.5)等が設定されていても
                               //   ラベルは常に完全不透明で描画し、グラフカラーを正しく表示する
        ctx.font = `bold ${fontSize}px ${fontFamily}`;
        ctx.textBaseline = "top";

        const lines = String(text).split('\n'); 
        const lineHeight = fontSize * 1.4;

        const widths = lines.map(t => ctx.measureText(t).width);
        const boxW = Math.max(...widths) + padding * 2;
        const boxH = lineHeight * lines.length + padding * 2;

        ctx.fillStyle = bg;
        ctx.fillRect(x, y, boxW, boxH);

        // ★ v14.3: strokeText で黒縁取りを追加 → 白い背景・明るい服でもくっきり読める
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        lines.forEach((t, i) => {
            ctx.strokeText(t, x + padding, y + padding + i * lineHeight);
        });

        ctx.fillStyle = color;
        lines.forEach((t, i) => {
            ctx.fillText(t, x + padding, y + padding + i * lineHeight);
        });

        ctx.restore();
    }

    /* ----- 共通ダウンロード helper ----- */
    function _download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        // 500ms 後に URL と <a> を解放（ダウンロード開始後は不要・大容量 Blob の長期保持を避ける）
        // 100ms だと DL 拡張機能や低速端末でファイル書き込み前に URL が消えるリスクがある
        setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
        }, 500);
    }

    /* ============================================================
    21. Mobile Sidebar Toggle
    ============================================================ */
    function toggleMobileSidebar() {
        const sidebar = document.getElementById('joint-accordion');
        if(sidebar) sidebar.classList.toggle('mobile-open');
    }

    // モバイル判定でサイドバートグルを表示
    function checkMobileLayout() {
        const isMobile = window.innerWidth <= 700;
        const btn = document.getElementById('btn-sidebar-toggle');
        if(btn) btn.style.display = isMobile ? '' : 'none';
        
        document.querySelectorAll('.hd-label').forEach(el => {
            el.style.display = isMobile ? 'none' : '';
        });

        // ★ リサイズ時（iPad縦横回転など）にスクロールフェードを必ず再評価
        updateScrollFade();
    }

    /* ============================================================
       キーボードショートカット (v15i UX強化)
    ============================================================ */
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (document.getElementById('export-modal').classList.contains('open')) return;
        if (document.getElementById('settings-drawer').classList.contains('open') && e.code !== 'Escape') return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                seek(e.shiftKey ? -10/30 : -1/30);
                break;
            case 'ArrowRight':
                e.preventDefault();
                seek(e.shiftKey ? 10/30 : 1/30);
                break;
            case 'KeyA':
                setRepeatA();
                break;
            case 'KeyB':
                setRepeatB();
                break;
            case 'KeyC':
            case 'Escape':
                if (e.code === 'Escape' && document.getElementById('settings-drawer').classList.contains('open')) {
                    toggleSettings();
                } else {
                    clearRepeat();
                }
                break;
            case 'KeyS':
                saveSegment();
                break;
        }
    });

    window.addEventListener('resize', checkMobileLayout);
    checkMobileLayout();

