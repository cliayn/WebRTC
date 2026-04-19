// 二维码扫码功能模块
// 依赖的全局变量：myId, targetId, role, pc, ws, pendingIceCandidates, localCandidates, qrcodeDiv
// 依赖的全局函数：addLog, showModal, connectSignaling, createPeerConnection, buildSDP, buildICECandidate
// 依赖的DOM元素：video, canvas, scanResult, scanSection

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
    const compressed = { id: myId, u, p, f, ice: iceCompact };
    qrcodeDiv.innerHTML = '';
    QRCode.toCanvas(document.createElement('canvas'), JSON.stringify(compressed), { width: 300 }, (err, canvas) => {
        if (err) return;
        qrcodeDiv.appendChild(canvas);
        addLog('[二维码] 已生成');
    });
}

// 处理扫描到的压缩数据
async function handleScannedCompressed(compressedStr) {
    try {
        const data = JSON.parse(compressedStr);
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