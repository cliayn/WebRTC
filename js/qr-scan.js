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
    const iceCompact = localCandidates.map(c => {
        const parts = c.candidate.split(' ');
        const typIdx = parts.indexOf('typ');
        return { ip: parts[typIdx-2], port: parseInt(parts[typIdx-1]), type: parts[typIdx+1] };
    });
    const data = { id: myId, u, p, f, ice: iceCompact };

    // 压缩数据
    const compressedBase64 = compressData(data);
    if (!compressedBase64) {
        // 压缩失败，回退到JSON
        addLog('[二维码] 压缩失败，使用JSON');
        const jsonStr = JSON.stringify(data);
        qrcodeDiv.innerHTML = '';
        QRCode.toCanvas(document.createElement('canvas'), jsonStr, { width: 300 }, (err, canvas) => {
            if (err) return;
            qrcodeDiv.appendChild(canvas);
            addLog('[二维码] 已生成（JSON）');
        });
        return;
    }

    // 添加压缩标记前缀，方便识别
    const qrData = 'C:' + compressedBase64;
    qrcodeDiv.innerHTML = '';
    QRCode.toCanvas(document.createElement('canvas'), qrData, { width: 300 }, (err, canvas) => {
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
        connectionFailureCount = 0;

        targetId = data.id;
        role = 'sender';
        const { u, p, f, ice } = data;
        const offerSdp = buildSDP('offer', u, p, f);
        createPeerConnection();
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        // 添加远程ICE
        for (const ic of ice) {
            await pc.addIceCandidate({ candidate: buildICECandidate(ic.ip, ic.port, ic.type, u), sdpMid: '0', sdpMLineIndex: 0 });
        }
        // 添加缓存ICE
        while (pendingIceCandidates.length) {
            const cand = pendingIceCandidates.shift();
            await pc.addIceCandidate({ candidate: cand, sdpMid: '0', sdpMLineIndex: 0 }).catch(e=>addLog('[缓存ICE添加失败] '+e));
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const ansSdp = answer.sdp;
        const ansU = ansSdp.match(/a=ice-ufrag:(.+)/)[1];
        const ansP = ansSdp.match(/a=ice-pwd:(.+)/)[1];
        const ansF = ansSdp.match(/a=fingerprint:sha-256 (.+)/)[1];
        const answerCompressed = { u: ansU, p: ansP, f: ansF, ice: [] };
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