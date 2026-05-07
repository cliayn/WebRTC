// 二维码扫码功能模块
// 依赖的全局变量：myId, targetId, role, pc, ws, pendingIceCandidates, localCandidates, qrcodeDiv
// 依赖的全局函数：addLog, showModal, connectSignaling, createPeerConnection, buildSDP, buildICECandidate
// 依赖的DOM元素：video, canvas, scanResult, scanSection

// 压缩数据（使用pako的deflate + base64）
function compressData(obj) {
    try {
        const jsonStr = JSON.stringify(obj);
        const encoder = new TextEncoder();
        const data = encoder.encode(jsonStr);
        const compressed = pako.deflate(data);
        // 转换为base64以便在二维码中显示
        let binary = '';
        const bytes = new Uint8Array(compressed);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    } catch (err) {
        console.error('压缩失败:', err);
        return null;
    }
}

// 解压数据
function decompressData(base64Str) {
    try {
        const binary = atob(base64Str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const decompressed = pako.inflate(bytes);
        const decoder = new TextDecoder();
        const jsonStr = decoder.decode(decompressed);
        return JSON.parse(jsonStr);
    } catch (err) {
        console.error('解压失败:', err);
        return null;
    }
}

// 生成压缩二维码
function generateCompressedQR() {
    if (!pc || !pc.localDescription) return;
    const sdp = pc.localDescription.sdp;
    const u = sdp.match(/a=ice-ufrag:(.+)/)[1];
    const p = sdp.match(/a=ice-pwd:(.+)/)[1];
    const f = sdp.match(/a=fingerprint:sha-256 (.+)/)[1];

    var iceCompact = [];
    var embeddedSet = {};

    // 1. Shadow PC 预热候选
    var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
    for (var si = 0; si < shadowCands.length; si++) {
        var sc = shadowCands[si];
        var skey = sc.ip + ':' + sc.port;
        if (!embeddedSet[skey]) {
            embeddedSet[skey] = true;
            iceCompact.push({ ip: sc.ip, port: sc.port, type: sc.type });
        }
    }

    // 2. 已收集的真实候选（过滤TCP和低端口，加速QR压缩）
    for (var ci = 0; ci < localCandidates.length; ci++) {
        const candStr = localCandidates[ci].candidate;
        const parts = candStr.split(' ');
        const typIdx = parts.indexOf('typ');
        // 跳过TCP候选（包含tcptype）和低端口候选
        if (typIdx > 1 && parseInt(parts[typIdx - 1], 10) >= 1024 && !candStr.includes('tcptype')) {
            var lcIp = parts[typIdx - 2];
            var lcPort = parseInt(parts[typIdx - 1], 10);
            var lcType = parts[typIdx + 1];
            var lcKey = lcIp + ':' + lcPort;
            if (!embeddedSet[lcKey]) {
                embeddedSet[lcKey] = true;
                iceCompact.push({ ip: lcIp, port: lcPort, type: lcType });
            }
        }
    }

    // 提取本机STUN IP
    var stunIp = window.getLocalStunIp ? window.getLocalStunIp() : null;
    if (!stunIp) {
        // fallback: 从iceCompact中查找srflx
        for (var si2 = 0; si2 < iceCompact.length; si2++) {
            if (iceCompact[si2].type === 'srflx') { stunIp = iceCompact[si2].ip; break; }
        }
    }
    addLog('[STUN检测] 本机STUN IPv4: ' + (stunIp || '无'));

    const data = { id: myId, u, p, f, ice: iceCompact, stunIp: stunIp };

    // 压缩数据
    const compressedBase64 = compressData(data);
    if (!compressedBase64) {
        // 压缩失败，回退到JSON
        addLog('[二维码] 压缩失败，使用JSON');
        const jsonStr = JSON.stringify(data);
        qrcodeDiv.innerHTML = '';
        QRCode.toCanvas(document.createElement('canvas'), jsonStr, { width: 360 }, (err, canvas) => {
            if (err) return;
            qrcodeDiv.appendChild(canvas);
            addLog('[二维码] 已生成（JSON）');
        });
        return;
    }

    // 添加压缩标记前缀，方便识别
    const qrData = 'C:' + compressedBase64;
    qrcodeDiv.innerHTML = '';
    QRCode.toCanvas(document.createElement('canvas'), qrData, { width: 360 }, (err, canvas) => {
        if (err) return;
        qrcodeDiv.appendChild(canvas);
        addLog('[二维码] 已生成（压缩版）');
    });
}

// 处理扫描到的压缩数据
async function handleScannedCompressed(compressedStr) {
    try {
        let data;

        // 检查是否为压缩数据（以'C:'开头）
        if (compressedStr.startsWith('C:')) {
            const base64Data = compressedStr.substring(2);
            data = decompressData(base64Data);
            if (!data) {
                addLog('[扫描处理] 解压失败，尝试解析为JSON');
                // 尝试解析为JSON
                data = JSON.parse(compressedStr);
            }
        } else {
            // 尝试解析为JSON
            data = JSON.parse(compressedStr);
        }

        if (!data || !data.id) {
            addLog('[扫描处理] 数据格式无效');
            return;
        }

        // 重置运营商NAT状态，避免旧连接干扰
        gatewayBurstAttempted = false;
        carrierNatHandlingStage = 0;
        carrierNatDetectedIp = null;
        carrierNatRealTimeDetectionTriggered = false;
        carrierNatReplacementMap = {};
        burstEnabledByStunMatch = false;
        localStunIp = null;
        remoteStunIp = null;
        connectionFailureCount = 0;

        // 显示加载覆盖层
        if (window.showLoadingOverlay) {
            window.showLoadingOverlay('正在与 ' + data.id + ' 建立连接...');
        }

        targetId = data.id;
        role = 'sender';
        // 重置去重表
        if (window._embeddedIceSet) _embeddedIceSet = {};

        // 创建连接条目，使扫码连接也显示在侧边栏
        if (window.createConnectionEntry) {
            window.createConnectionEntry(targetId, role);
        }
        const { u, p, f, ice, stunIp: remoteStun } = data;
        const offerCandidates = ice || [];

        // STUN IP比对：双方STUN IPv4相同 → 同一运营商NAT → 启用爆破
        localStunIp = window.getLocalStunIp ? window.getLocalStunIp() : null;
        remoteStunIp = remoteStun || null;
        if (localStunIp && remoteStunIp && localStunIp === remoteStunIp) {
            burstEnabledByStunMatch = true;
            addLog('[STUN检测] 双方STUN IP相同 (' + localStunIp + ')，启用网关爆破');
        } else {
            burstEnabledByStunMatch = false;
            addLog('[STUN检测] 本机=' + (localStunIp || '无') + ' 对方=' + (remoteStunIp || '无') + '，关闭网关爆破');
        }

        createPeerConnection();
        // 构建SDP并嵌入in-band候选
        const offerSdp = buildSDP('offer', u, p, f, offerCandidates);
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

        // 先处理缓存ICE（trickle ICE有正确的端口，优先触发爆破）
        while (pendingIceCandidates.length) {
            const cand = pendingIceCandidates.shift();
            await handleRemoteIce(cand);
        }
        // 再作为fallback显式添加in-band候选（跳过爆破，仅添加真实候选）
        for (var icIdx = 0; icIdx < offerCandidates.length; icIdx++) {
            var ic = offerCandidates[icIdx];
            await handleRemoteIce(buildICECandidate(ic.ip, ic.port, ic.type, u), true);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);


        const ansSdp = answer.sdp;
        const ansU = ansSdp.match(/a=ice-ufrag:(.+)/)[1];
        const ansP = ansSdp.match(/a=ice-pwd:(.+)/)[1];
        const ansF = ansSdp.match(/a=fingerprint:sha-256 (.+)/)[1];

        // 收集应答方候选
        var answerIceCompact = [];
        var aEmbeddedSet = {};
        var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
        for (var si = 0; si < shadowCands.length; si++) {
            var sc = shadowCands[si];
            var skey = sc.ip + ':' + sc.port;
            if (!aEmbeddedSet[skey]) {
                aEmbeddedSet[skey] = true;
                answerIceCompact.push({ ip: sc.ip, port: sc.port, type: sc.type });
            }
        }
        for (var lai = 0; lai < localCandidates.length; lai++) {
            var alc = localCandidates[lai];
            var aParts = alc.candidate.split(' ');
            var aTypIdx = aParts.indexOf('typ');
            if (aTypIdx > 1) {
                var aPort = parseInt(aParts[aTypIdx - 1], 10);
                if (aPort >= 1024) {
                    var aIp = aParts[aTypIdx - 2];
                    var aKey = aIp + ':' + aPort;
                    if (!aEmbeddedSet[aKey]) {
                        aEmbeddedSet[aKey] = true;
                        answerIceCompact.push({ ip: aIp, port: aPort, type: aParts[aTypIdx + 1] });
                    }
                }
            }
        }

        const answerCompressed = { u: ansU, p: ansP, f: ansF, ice: answerIceCompact, stunIp: localStunIp };
        ws.send(JSON.stringify({ type: 'answer', target: targetId, payload: answerCompressed }));
        addLog('[发送Answer] 完成');
    } catch (e) {
        addLog('[扫描处理错误] ' + e);
    }
}

// 开始扫描
async function startScan() {
    try {
        await connectSignaling();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = document.getElementById('video');
        video.srcObject = stream;
        video.style.display = 'block';
        video.play();
        scanningActive = true;
        scanLoop();
    } catch(e) {
        alert('摄像头或信令连接失败，请到高级功能调整');
    }
}

// 扫描循环
function scanLoop() {
    if (!scanningActive) return;
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code) {
            scanningActive = false;
            video.srcObject.getTracks().forEach(t => t.stop());
            video.style.display = 'none';
            document.getElementById('scanResult').textContent = '✅ 扫描成功';
            handleScannedCompressed(code.data);
            // 自动关闭扫码覆盖层，优化用户体验
            setTimeout(function() {
                scanSection.style.display = 'none';
            }, 1000);
            return;
        }
    }
    requestAnimationFrame(scanLoop);
}

// 将函数挂载到window对象
window.generateCompressedQR = generateCompressedQR;
window.handleScannedCompressed = handleScannedCompressed;
window.startScan = startScan;
window.scanLoop = scanLoop;
window.compressData = compressData;
window.decompressData = decompressData;