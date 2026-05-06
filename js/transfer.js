// 传输功能模块 v2.3.0 — 多连接聊天 + 全量流式文件传输
//
//   ✔ ACK 应用层流控  ✔ 4路并发数据通道
//   ✔ Gzip 压缩        ✔ 断点续传
//   ✔ 进度同步         ✔ 全量流式落盘（File System Access API / StreamSaver）
//
// 依赖全局：connections, activePeerId, dc, pc
// 依赖全局函数：addLog, showModal, streamSaver（可选）

// ========== 常量 ==========
var CHUNK_SIZE           = 64 * 1024;        // 每个切片 64KB
var CHANNEL_COUNT        = 4;                // 并发数据通道数
var ACK_INTERVAL_MS      = 80;               // ACK 最小间隔（毫秒）
var ACK_CHUNK_STEP       = 32;               // 每收到 N 个块发一次 ACK
var INIT_WINDOW          = 8;                // 每通道初始飞行窗口（块数）= 512KB
var MAX_WINDOW           = 32;               // 每通道最大飞行窗口 = 2MB
var MIN_WINDOW           = 2;                // 每通道最小飞行窗口
var BUFFER_SOFT_CAP      = 4 * 1024 * 1024;  // 单通道缓冲区软上限 4MB
var MAX_PIPELINE         = 128;              // 全局管道上限（块）= 8MB 总在途数据
var STALL_TIMEOUT_MS     = 5000;             // 停顿检测超时
var MAX_CONCURRENT_WRITES = 32;              // 接收端最大并发落盘写入数

// 并发通道固定 ID（高段位，避免与主通道冲突）
var TF_CHANNEL_IDS = [1000, 1001, 1002, 1003];

// ========== 传输状态 ==========
var _tf = {};  // peerId -> TransferSession

// ========== 创建主数据通道 ==========
function createDataChannel() {
    dc = pc.createDataChannel('fileTransfer');
    dc.binaryType = 'arraybuffer';
    dc.onopen  = function () { addLog('[数据通道] 已创建'); };
    dc.onclose = function () { addLog('[数据通道] 关闭'); };
}

// ========== DC就绪握手（双方DC都open后才打开聊天UI） ==========
function _announceDcReady(peerId) {
    var conn = connections[peerId];
    if (!conn) return;
    conn._localDcReady = true;
    // 发送chat-ready通知对方
    if (conn.dc && conn.dc.readyState === 'open') {
        conn.dc.send(JSON.stringify({ type: 'chat-ready' }));
        addLog('[聊天就绪] 本地DC已就绪，已通知 ' + peerId);
    }
    _tryOpenChat(peerId);
}

function _onChatReady(peerId) {
    var conn = connections[peerId];
    if (!conn) return;
    conn._remoteDcReady = true;
    addLog('[聊天就绪] 对方 ' + peerId + ' DC已就绪');
    _tryOpenChat(peerId);
}

function _tryOpenChat(peerId) {
    var conn = connections[peerId];
    if (!conn) return;
    if (conn._localDcReady && conn._remoteDcReady) {
        // 双方DC都已就绪，打开聊天界面
        if (window._openPeerChat) {
            window._openPeerChat(peerId);
        }
    }
}

// ========== 为主数据通道设置消息处理器 ==========
function setupDataChannelForPeer(peerId, channel) {
    // 防止重复设置（channel._setupDone标记）
    if (channel._setupDone) return;
    channel._setupDone = true;

    channel.binaryType = 'arraybuffer';

    channel.onopen = function () {
        addLog('[数据通道] ' + peerId + ' 已打开');
        addPeerMessage(peerId, 'system', '数据通道已建立');
        _announceDcReady(peerId);
    };

    channel.onclose = function () {
        addLog('[数据通道] ' + peerId + ' 关闭');
        _abortTransfer(peerId);
    };

    // 如果通道已经打开，立即宣布就绪
    if (channel.readyState === 'open') {
        addLog('[数据通道] ' + peerId + ' 已处于打开状态');
        _announceDcReady(peerId);
    }

    channel.onmessage = function (e) {
        if (typeof e.data !== 'string') return;

        var msg;
        try { msg = JSON.parse(e.data); } catch (ex) { return; }

        if (msg.type === 'transfer-header') {
            _onTransferHeader(peerId, msg);
        } else if (msg.type === 'transfer-ready') {
            _onTransferReady(peerId);
        } else if (msg.type === 'transfer-ack') {
            _onTransferAck(peerId, msg);
        } else if (msg.type === 'transfer-resume') {
            _onTransferResume(peerId, msg);
        } else if (msg.type === 'transfer-complete') {
            _onTransferComplete(peerId);
        } else if (msg.type === 'transfer-cancel') {
            addPeerMessage(peerId, 'system', '对方取消了传输');
            _abortTransfer(peerId);
        } else if (msg.type === 'chat') {
            addPeerMessage(peerId, 'peer', msg.text);
        } else if (msg.type === 'chat-ready') {
            _onChatReady(peerId);
        } else if (msg.type === 'disconnect') {
            addLog('[同步断开] ' + peerId + ' 已断开连接');
            addPeerMessage(peerId, 'system', '对方已断开连接');
            setTimeout(function () {
                if (window.cleanupConnection) window.cleanupConnection(peerId);
            }, 100);
        }
    };
}

// ========== 对外入口：发送文件 ==========
function sendFileOverDC(dcChannel, file, peerId) {
    if (_tf[peerId]) {
        addLog('[传输] 已有传输进行中，忽略');
        return;
    }

    var totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    _tf[peerId] = {
        direction: 'send',
        file: file,
        fileName: file.name,
        fileSize: file.size,
        totalChunks: totalChunks,
        chunkSize: CHUNK_SIZE,
        sentCount: 0,
        ackedCount: 0,
        channels: [],
        _startTime: Date.now(),
        _lastSendTime: Date.now(),
        _lastAckTime: 0,
        _stallTimer: 0
    };

    dcChannel.send(JSON.stringify({
        type: 'transfer-header',
        name: file.name,
        size: file.size,
        totalChunks: totalChunks,
        chunkSize: CHUNK_SIZE,
        channelCount: CHANNEL_COUNT,
        channelIds: TF_CHANNEL_IDS
    }));

    _showProgress(peerId, file.name, file.size);
    addPeerMessage(peerId, 'system', '准备发送: ' + file.name + ' (' + _fmtSize(file.size) + ', ' + totalChunks + ' 块)');
}

// ========================================================================
//  发送端
// ========================================================================

// transfer-ready → 创建并发数据通道并开始发送
function _onTransferReady(peerId) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;

    addLog('[传输] 对方已就绪，建立 ' + CHANNEL_COUNT + ' 路并发通道...');

    var file = s.file;
    var assignedChunks = _splitChunks(s.totalChunks, CHANNEL_COUNT);
    var sendPc = (connections[peerId] && connections[peerId].pc) ? connections[peerId].pc : pc;

    // 使用协商通道（negotiated:true），双方用相同 ID，无需信令
    for (var i = 0; i < CHANNEL_COUNT; i++) {
        var label = 'tf-ch-' + i;
        var chId = TF_CHANNEL_IDS[i];
        try {
            var ch = sendPc.createDataChannel(label, {
                negotiated: true,
                id: chId,
                ordered: true
            });
            ch.binaryType = 'arraybuffer';
            _setupSendChannel(peerId, ch, i, assignedChunks[i]);
            s.channels.push({
                dc: ch,
                label: label,
                window: INIT_WINDOW,
                inFlight: 0,
                nextChunk: assignedChunks[i][0],
                endChunk: assignedChunks[i][1]
            });
        } catch (err) {
            addLog('[传输] 创建通道 ' + label + ' 失败: ' + err);
        }
    }

    // 等待通道就绪后开始泵送
    _waitChannelsAndPump(peerId);
}

// 切分 chunk 范围到各通道（轮询分配）
function _splitChunks(total, ways) {
    var ranges = [];
    for (var w = 0; w < ways; w++) ranges.push([-1, -1]); // [start, end]

    for (var i = 0; i < total; i++) {
        var w = i % ways;
        if (ranges[w][0] === -1) ranges[w][0] = i;
        ranges[w][1] = i;
    }
    return ranges;  // 未分配到任务的通道为 [-1, -1]
}

// 建立单条发送通道的事件
function _setupSendChannel(peerId, ch, idx, range) {
    ch.onopen = function () {
        addLog('[传输] 发送通道 ' + idx + ' 已打开');
    };
    ch.onclose = function () {
        addLog('[传输] 发送通道 ' + idx + ' 关闭');
    };
    // bufferedamountlow — 缓冲区排空后自动恢复泵送
    try { ch.bufferedAmountLowThreshold = 256 * 1024; } catch (e) { }
    ch.onbufferedamountlow = function () {
        var s = _tf[peerId];
        if (!s) return;
        if (s.sentCount - s.ackedCount < MAX_PIPELINE) {
            _pumpChannel(peerId, idx);
        }
    };
}

// 等待所有协商通道打开后启动泵送
function _waitChannelsAndPump(peerId) {
    var s = _tf[peerId];
    if (!s) return;

    var checkAllOpen = function () {
        if (!_tf[peerId]) return;
        var s2 = _tf[peerId];
        var allOpen = true;
        for (var i = 0; i < s2.channels.length; i++) {
            if (!s2.channels[i].dc || s2.channels[i].dc.readyState !== 'open') {
                allOpen = false;
                break;
            }
        }
        if (allOpen) {
            addLog('[传输] ' + s2.channels.length + ' 路并发通道全部就绪');
            for (var j = 0; j < s2.channels.length; j++) {
                _pumpChannel(peerId, j);
            }
            _startStallDetector(peerId);
        } else {
            setTimeout(checkAllOpen, 100);
        }
    };
    setTimeout(checkAllOpen, 200);
}

// 单通道泵送（核心发送循环）
function _pumpChannel(peerId, chIdx) {
    var s = _tf[peerId];
    if (!s) return;
    var ci = s.channels[chIdx];
    if (!ci) return;

    var file = s.file;
    var isResume = !!ci._missingList;
    var step = isResume ? 1 : CHANNEL_COUNT;  // 恢复模式走缺失列表，初始模式走轮询步长

    while (ci.inFlight < ci.window && ci.nextChunk <= ci.endChunk) {
        // 全局管道保护
        if (s.sentCount - s.ackedCount >= MAX_PIPELINE) return;

        // 单通道缓冲区软控 — 满了就退避，不卡死
        if (ci.dc.bufferedAmount > BUFFER_SOFT_CAP) {
            ci.window = Math.max(MIN_WINDOW, ci.window - 1);
            return;
        }

        var realChunkIdx;
        if (isResume) {
            realChunkIdx = ci._missingList[ci.nextChunk];
            if (realChunkIdx === undefined) { ci.nextChunk++; continue; }
        } else {
            realChunkIdx = ci.nextChunk;
        }

        ci.inFlight++;
        ci.nextChunk += step;

        var offset = realChunkIdx * CHUNK_SIZE;
        var rawData = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));

        var reader = new FileReader();
        (function (cIdx, rChunk, cData) {
            reader.onload = async function (re) {
                var payload = new Uint8Array(re.target.result);

                var flags = 0;
                if (payload.length >= 512) {
                    var compressed = await _compress(payload);
                    if (compressed && compressed.length < payload.length) {
                        payload = compressed;
                        flags = 1;
                    }
                }

                var header = new ArrayBuffer(5);
                new DataView(header).setUint32(0, rChunk, false);
                new DataView(header).setUint8(4, flags);
                var frame = new Uint8Array(5 + payload.length);
                frame.set(new Uint8Array(header), 0);
                frame.set(payload, 5);

                if (!_tf[peerId]) return;
                var sNow = _tf[peerId];
                var sci = sNow.channels[cIdx];
                if (!sci) return;

                try {
                    sci.dc.send(frame.buffer);
                } catch (e) {
                    addLog('[传输] 通道 ' + cIdx + ' 发送失败: ' + e);
                    return;
                }

                sNow.sentCount++;
                sNow._lastSendTime = Date.now();

                // 发送端进度 = 接收端确认数（双方进度一致）
                _updateProgress(peerId, sNow.ackedCount, sNow.totalChunks);

                // 管道有余量 → 继续泵送
                if (sNow.sentCount - sNow.ackedCount < MAX_PIPELINE) {
                    _pumpChannel(peerId, cIdx);
                }
            };
            reader.readAsArrayBuffer(cData);
        })(chIdx, realChunkIdx, rawData);
    }
}

// 收到 ACK → 更新进度、减小 inFlight、调整窗口、继续泵送
function _onTransferAck(peerId, msg) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;

    var oldAcked = s.ackedCount;
    s.ackedCount = msg.receivedCount;
    var delta = s.ackedCount - oldAcked;
    if (delta <= 0) return;

    s._lastAckTime = Date.now();

    // 发送端进度 = 接收端确认数
    _updateProgress(peerId, s.ackedCount, s.totalChunks);

    var pipeline = s.sentCount - s.ackedCount;

    // 更精准的 inFlight 分配：按各通道窗口占比
    var totalWindow = 0;
    for (var i = 0; i < s.channels.length; i++) {
        if (s.channels[i]) totalWindow += s.channels[i].window;
    }
    for (var i = 0; i < s.channels.length; i++) {
        var ci = s.channels[i];
        if (!ci) continue;
        var share = totalWindow > 0 ? ci.window / totalWindow : 1 / s.channels.length;
        ci.inFlight = Math.max(0, Math.ceil(pipeline * share));

        // 窗口自适应
        if (pipeline < MAX_PIPELINE / 3) {
            ci.window = Math.min(MAX_WINDOW, ci.window + 1);  // 通畅 → 逐步扩窗
        } else if (pipeline > MAX_PIPELINE * 0.7) {
            ci.window = Math.max(MIN_WINDOW, ci.window - 1);  // 拥堵 → 逐步缩窗
        }
    }

    // 管道未满 → 继续泵送所有通道
    if (pipeline < MAX_PIPELINE) {
        for (var j = 0; j < s.channels.length; j++) {
            _pumpChannel(peerId, j);
        }
    }
}

// receiver 确认收到全部 chunk
function _onTransferComplete(peerId) {
    var s = _tf[peerId];
    if (!s) return;

    var elapsed = (Date.now() - s._startTime) / 1000;
    var speed = s.fileSize / elapsed;
    addPeerMessage(peerId, 'system', '发送完成: ' + s.fileName + ' (' + _fmtSpeed(speed) + ')');
    _updateProgress(peerId, s.totalChunks, s.totalChunks);
    _hideProgress(peerId, 2000);
    _cleanupTransfer(peerId);
}

// ========================================================================
//  接收端
// ========================================================================

// 收到 transfer-header → modal → save dialog → ready
async function _onTransferHeader(peerId, msg) {
    var conn = connections[peerId];

    // 弹出确认框（提供用户手势，showSaveFilePicker 必需）
    if (window.showModal) {
        var ok = await window.showModal(
            '文件传输请求',
            peerId + ' 想要发送: ' + msg.name + ' (' + _fmtSize(msg.size) + ')',
            '📁'
        );
        if (!ok) {
            addPeerMessage(peerId, 'system', '拒绝接收');
            if (conn && conn.dc) {
                conn.dc.send(JSON.stringify({ type: 'transfer-cancel' }));
            }
            return;
        }
    }

    // 优先 File System Access API（随机写入），否则 StreamSaver（顺序流）
    var writable = null;
    var fileHandle = null;
    var streamWriter = null;

    if (window.showSaveFilePicker) {
        try {
            fileHandle = await window.showSaveFilePicker({ suggestedName: msg.name });
            writable = await fileHandle.createWritable();
        } catch (e) {
            addLog('[传输] 用户取消保存: ' + e);
            addPeerMessage(peerId, 'system', '接收已取消');
            if (conn && conn.dc) {
                conn.dc.send(JSON.stringify({ type: 'transfer-cancel' }));
            }
            return;
        }
    } else if (window.streamSaver) {
        try {
            var ws = window.streamSaver.createWriteStream(msg.name, { size: msg.size });
            streamWriter = ws.getWriter();
            addLog('[传输] StreamSaver 流式落盘（' + _fmtSize(msg.size) + '）');
        } catch (e) {
            addLog('[传输] StreamSaver 初始化失败: ' + e);
        }
    }

    // 无流式写入能力 → 拒绝传输
    if (!writable && !streamWriter) {
        addPeerMessage(peerId, 'system', '接收失败: 浏览器不支持流式写入，请使用 Chrome 或 Firefox');
        if (conn && conn.dc) {
            conn.dc.send(JSON.stringify({ type: 'transfer-cancel' }));
        }
        return;
    }

    var totalChunks = msg.totalChunks;

    _tf[peerId] = {
        direction: 'receive',
        fileName: msg.name,
        fileSize: msg.size,
        totalChunks: totalChunks,
        chunkSize: msg.chunkSize || CHUNK_SIZE,
        receivedMask: new Array(totalChunks),
        receivedCount: 0,
        writable: writable,
        fileHandle: fileHandle,
        _writesInFlight: 0,
        _writeQueue: [],                       // [{ idx, data }] — writable 路径
        _streamWriter: streamWriter,           // StreamSaver writer
        _streamBuffer: streamWriter ? {} : null,  // { chunkIdx: data } 重排缓冲
        _streamNextIdx: 0,
        _streamWriteChain: Promise.resolve(),
        _startTime: Date.now(),
        _lastAckTime: 0,
        _lastAckCount: 0
    };

    _showProgress(peerId, msg.name, msg.size);
    var modeLabel = streamWriter ? ' (StreamSaver)' : '';
    addPeerMessage(peerId, 'system', '开始接收: ' + msg.name + ' (' + _fmtSize(msg.size) + ', ' + totalChunks + ' 块' + modeLabel + ')');

    // 创建协商数据通道（与发送端使用相同 ID）
    var chCount = msg.channelCount || CHANNEL_COUNT;
    var chIds = msg.channelIds || TF_CHANNEL_IDS;
    var recvPc = conn && conn.pc ? conn.pc : pc;
    for (var i = 0; i < chCount; i++) {
        try {
            var ch = recvPc.createDataChannel('tf-ch-' + i, {
                negotiated: true,
                id: chIds[i],
                ordered: true
            });
            ch.binaryType = 'arraybuffer';
            _setupRecvChannel(peerId, ch, i);
        } catch (e) {
            addLog('[传输] 创建接收通道 ' + i + ' 失败: ' + e);
        }
    }

    // 通知发送端就绪
    if (conn && conn.dc) {
        conn.dc.send(JSON.stringify({ type: 'transfer-ready' }));
    }
}

// 建立接收端数据通道监听
function _setupRecvChannel(peerId, channel, idx) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = function () {
        addLog('[传输] 接收通道 ' + idx + ' 已打开');
    };
    channel.onclose = function () {
        addLog('[传输] 接收通道 ' + idx + ' 关闭');
    };
    channel.onmessage = function (e) {
        if (!(e.data instanceof ArrayBuffer)) return;
        if (!_tf[peerId]) return;

        var data = new Uint8Array(e.data);
        if (data.length < 5) return;

        // 解析帧头：[4B chunkIdx BE] [1B flags] [payload...]
        var headerView = new DataView(data.buffer, data.byteOffset, 5);
        var chunkIdx = headerView.getUint32(0, false);
        var flags = headerView.getUint8(4);
        var payload = data.slice(5);

        var s = _tf[peerId];
        if (!s) return;

        // 去重
        if (s.receivedMask[chunkIdx]) return;
        s.receivedMask[chunkIdx] = true;

        // 解压
        if (flags & 1) {
            _decompress(payload).then(function (decompressed) {
                _writeChunk(peerId, chunkIdx, decompressed);
            }).catch(function () {
                _writeChunk(peerId, chunkIdx, payload);
            });
        } else {
            _writeChunk(peerId, chunkIdx, payload);
        }
    };
}

// ====== 接收端写入（流式 + 边界并发 + 背压） ======

// 写入一个 chunk → File System Access API / StreamSaver
function _writeChunk(peerId, chunkIdx, data) {
    var s = _tf[peerId];
    if (!s) return;

    if (s.writable) {
        // 边界并发随机写入（带背压）
        if (s._writesInFlight >= MAX_CONCURRENT_WRITES) {
            s._writeQueue.push({ idx: chunkIdx, data: data });
            return;
        }
        _executeWrite(peerId, chunkIdx, data);
    } else if (s._streamWriter) {
        // 顺序流式写入（带重排缓冲）
        _streamWrite(peerId, chunkIdx, data);
    }
}

// File System Access API：执行单次随机位置写入
function _executeWrite(peerId, chunkIdx, data) {
    var s = _tf[peerId];
    if (!s) return;
    s._writesInFlight++;
    var offset = chunkIdx * s.chunkSize;
    s.writable.write({ type: 'write', position: offset, data: data })
        .then(function () {
            s._writesInFlight--;
            _onChunkWritten(peerId, chunkIdx);
            _drainWrites(peerId);
        })
        .catch(function (e) {
            s._writesInFlight--;
            addLog('[传输] 写入失败: ' + e);
            _drainWrites(peerId);
        });
}

// 排空写入等待队列
function _drainWrites(peerId) {
    var s = _tf[peerId];
    if (!s) return;
    while (s._writesInFlight < MAX_CONCURRENT_WRITES && s._writeQueue.length > 0) {
        var item = s._writeQueue.shift();
        _executeWrite(peerId, item.idx, item.data);
    }
}

// StreamSaver 顺序流式写入（自动重排乱序 chunk）
function _streamWrite(peerId, chunkIdx, data) {
    var s = _tf[peerId];
    if (!s) return;

    if (chunkIdx === s._streamNextIdx) {
        s._streamWriteChain = s._streamWriteChain.then(function () {
            return s._streamWriter.write(data);
        }).then(function () {
            _onChunkWritten(peerId, chunkIdx);
            s._streamNextIdx++;
            return _streamDrain(peerId);
        }).catch(function (e) {
            addLog('[传输] 流写入失败: ' + e);
        });
    } else if (chunkIdx > s._streamNextIdx) {
        s._streamBuffer[chunkIdx] = data;
    }
    // chunkIdx < _streamNextIdx → 已写过，忽略（去重已处理）
}

// 排空 StreamSaver 重排缓冲中的连续 chunk
function _streamDrain(peerId) {
    var s = _tf[peerId];
    if (!s) return Promise.resolve();

    function drainNext() {
        var chunkData = s._streamBuffer[s._streamNextIdx];
        if (chunkData !== undefined) {
            var idx = s._streamNextIdx;
            delete s._streamBuffer[idx];
            return s._streamWriter.write(chunkData).then(function () {
                _onChunkWritten(peerId, idx);
                s._streamNextIdx++;
                return drainNext();
            });
        }
        return Promise.resolve();
    }
    return drainNext();
}

// 单个 chunk 写入完成 → 更新进度 + 可能发 ACK
function _onChunkWritten(peerId, chunkIdx) {
    var s = _tf[peerId];
    if (!s) return;

    s.receivedCount++;
    _updateProgress(peerId, s.receivedCount, s.totalChunks);

    // ACK 节流
    var now = Date.now();
    var sinceLastAck = s.receivedCount - s._lastAckCount;
    if (sinceLastAck >= ACK_CHUNK_STEP || (now - s._lastAckTime > ACK_INTERVAL_MS && sinceLastAck > 0)) {
        s._lastAckTime = now;
        s._lastAckCount = s.receivedCount;

        var conn = connections[peerId];
        if (conn && conn.dc && conn.dc.readyState === 'open') {
            conn.dc.send(JSON.stringify({
                type: 'transfer-ack',
                receivedCount: s.receivedCount
            }));
        }
    }

    // 全部收齐 → 完成
    if (s.receivedCount >= s.totalChunks) {
        _finishReceive(peerId);
    }
}

// 接收完成
async function _finishReceive(peerId) {
    var s = _tf[peerId];
    if (!s) return;

    if (s.writable) {
        if (s._writesInFlight > 0) {
            await new Promise(function (r) { setTimeout(r, 100); });
        }
        try { await s.writable.close(); } catch (e) { }
    } else if (s._streamWriter) {
        s._streamWriteChain = s._streamWriteChain.then(function () {
            return s._streamWriter.close();
        }).catch(function () {});
        try { await s._streamWriteChain; } catch (e) { }
    }

    var elapsed = (Date.now() - s._startTime) / 1000;
    var speed = s.fileSize / elapsed;
    _updateProgress(peerId, s.totalChunks, s.totalChunks);
    addPeerMessage(peerId, 'system', '接收完成: ' + s.fileName + ' (' + _fmtSpeed(speed) + ')');

    // 通知发送端
    var conn = connections[peerId];
    if (conn && conn.dc && conn.dc.readyState === 'open') {
        conn.dc.send(JSON.stringify({ type: 'transfer-complete' }));
    }

    _hideProgress(peerId, 2500);
    _cleanupTransfer(peerId);
}

// ========================================================================
//  断点续传
// ========================================================================

// 连接恢复时调用（外部可触发）
function tryResumeTransfer(peerId, channel) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'receive' || s.receivedCount >= s.totalChunks) return false;

    // 收集缺失的 chunk 索引
    var missing = [];
    for (var i = 0; i < s.totalChunks; i++) {
        if (!s.receivedMask[i]) missing.push(i);
    }

    if (missing.length === 0) {
        // 理论上不该到这里（receivedCount < totalChunks 但有 mask 全满）
        _finishReceive(peerId);
        return true;
    }

    addLog('[传输] 断点续传: 已收 ' + s.receivedCount + '/' + s.totalChunks + '，缺 ' + missing.length + ' 块');
    // 发送续传请求（发送端收到 transfer-resume 后重新发送缺失块）
    channel.send(JSON.stringify({
        type: 'transfer-resume',
        receivedCount: s.receivedCount,
        totalChunks: s.totalChunks,
        missingChunks: missing  // 直接列出缺失的块
    }));
    return true;
}

// 发送端收到断点续传请求
function _onTransferResume(peerId, msg) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;

    var missing = msg.missingChunks;
    if (!missing || missing.length === 0) {
        _onTransferComplete(peerId);
        return;
    }

    addLog('[传输] 断点续传: 缺失 ' + missing.length + ' 块');

    s.ackedCount = msg.receivedCount;
    s.sentCount = msg.receivedCount;
    s.channels = [];

    // 将缺失块切片分配到各通道
    var assigned = _splitChunks(missing.length, CHANNEL_COUNT);
    var resumePc = (connections[peerId] && connections[peerId].pc) ? connections[peerId].pc : pc;

    for (var i = 0; i < CHANNEL_COUNT; i++) {
        var range = assigned[i];
        var startIdx = (range[0] >= 0 && range[0] < missing.length) ? range[0] : -1;
        var endIdx   = (range[1] >= 0 && range[1] < missing.length) ? range[1] : -1;

        try {
            var ch = resumePc.createDataChannel('tf-ch-' + i, {
                negotiated: true, id: TF_CHANNEL_IDS[i], ordered: true
            });
            ch.binaryType = 'arraybuffer';
            _setupSendChannel(peerId, ch, i, [startIdx >= 0 ? missing[startIdx] : -1, endIdx >= 0 ? missing[endIdx] : -1]);

            s.channels.push({
                dc: ch, label: 'tf-ch-' + i, window: INIT_WINDOW,
                inFlight: 0,
                nextChunk: startIdx,
                endChunk: endIdx,
                _missingList: missing
            });
        } catch (e) {
            addLog('[传输] 续传通道 ' + i + ' 创建失败: ' + e);
        }
    }

    _waitChannelsAndPumpResume(peerId);
}

// 续传版本：等待通道就绪后泵送
function _waitChannelsAndPumpResume(peerId) {
    var s = _tf[peerId];
    if (!s) return;
    var check = function () {
        if (!_tf[peerId]) return;
        var s2 = _tf[peerId];
        var allOpen = true;
        for (var i = 0; i < s2.channels.length; i++) {
            if (!s2.channels[i].dc || s2.channels[i].dc.readyState !== 'open') { allOpen = false; break; }
        }
        if (allOpen) {
            for (var j = 0; j < s2.channels.length; j++) _pumpChannel(peerId, j);
            _startStallDetector(peerId);
        } else {
            setTimeout(check, 100);
        }
    };
    setTimeout(check, 200);
}

// ========================================================================
//  压缩
// ========================================================================

async function _compress(data) {
    try {
        var cs = new CompressionStream('gzip');
        var writer = cs.writable.getWriter();
        var reader = cs.readable.getReader();
        writer.write(data);
        writer.close();
        var chunks = [];
        while (true) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
        }
        if (chunks.length === 1) return new Uint8Array(chunks[0]);
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < chunks.length; j++) {
            out.set(new Uint8Array(chunks[j]), off);
            off += chunks[j].byteLength;
        }
        return out;
    } catch (e) {
        return null;  // 压缩失败则返回原数据
    }
}

async function _decompress(data) {
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    var reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    var chunks = [];
    while (true) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
    }
    if (chunks.length === 1) return new Uint8Array(chunks[0]);
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
        out.set(new Uint8Array(chunks[j]), off);
        off += chunks[j].byteLength;
    }
    return out;
}

// ========================================================================
//  辅助
// ========================================================================

function _startStallDetector(peerId) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;
    if (s._stallTimer) clearTimeout(s._stallTimer);

    s._stallTimer = setTimeout(function () {
        if (!_tf[peerId]) return;
        var s2 = _tf[peerId];
        if (s2.direction !== 'send') return;

        var now = Date.now();
        var sinceSend = now - (s2._lastSendTime || now);
        var sinceAck  = s2._lastAckTime ? now - s2._lastAckTime : Infinity;

        // 超过停顿阈值且管道未满 → 强制重试泵送
        if (sinceSend > STALL_TIMEOUT_MS && s2.sentCount - s2.ackedCount < MAX_PIPELINE) {
            addLog('[传输] 检测到停顿，强制恢复泵送...');
            for (var j = 0; j < s2.channels.length; j++) {
                var ci = s2.channels[j];
                if (ci) {
                    ci.window = Math.max(MIN_WINDOW, ci.window);
                    _pumpChannel(peerId, j);
                }
            }
        }

        // 继续下一次检测
        if (s2.sentCount < s2.totalChunks || s2.ackedCount < s2.totalChunks) {
            _startStallDetector(peerId);
        }
    }, STALL_TIMEOUT_MS);
}

function _abortTransfer(peerId) {
    _cleanupTransfer(peerId);
    _hideProgress(peerId, 0);
}

function _cleanupTransfer(peerId) {
    var s = _tf[peerId];
    if (!s) return;
    if (s._stallTimer) { clearTimeout(s._stallTimer); s._stallTimer = 0; }
    if (s.channels) {
        for (var i = 0; i < s.channels.length; i++) {
            try { if (s.channels[i].dc) s.channels[i].dc.close(); } catch (e) { }
        }
    }
    if (s.writable) {
        try { s.writable.abort(); } catch (e) { }
    }
    if (s._streamWriter) {
        try { s._streamWriter.abort(); } catch (e) { }
    }
    // 释放缓冲
    s._writeQueue = null;
    s._streamBuffer = null;
    s._streamWriteChain = null;
    delete _tf[peerId];
}

// ========================================================================
//  进度条 UI
// ========================================================================

var _lastProgTime = {};
var _progHideTimer = {};

function _showProgress(peerId, name, size) {
    var bar = _getBar(peerId);
    if (!bar) return;
    bar.classList.remove('hidden');
    var ne = bar.querySelector('.transfer-progress-name');
    var fi = bar.querySelector('.transfer-progress-fill');
    var pe = bar.querySelector('.transfer-progress-percent');
    var se = bar.querySelector('.transfer-progress-speed');
    if (ne) ne.textContent = name + ' (' + _fmtSize(size) + ')';
    if (fi) fi.style.width = '0%';
    if (pe) pe.textContent = '0%';
    if (se) se.textContent = '';
    _lastProgTime[peerId] = 0;
}

function _updateProgress(peerId, chunks, total) {
    var now = Date.now();
    var pct = (chunks / total) * 100;
    // 节流：每 100ms 更新一次（100% 立刻更新）
    if (now - (_lastProgTime[peerId] || 0) < 100 && chunks < total) return;
    _lastProgTime[peerId] = now;

    var bar = _getBar(peerId);
    if (!bar) return;

    var fi = bar.querySelector('.transfer-progress-fill');
    var pe = bar.querySelector('.transfer-progress-percent');
    var se = bar.querySelector('.transfer-progress-speed');

    if (fi) fi.style.width = pct.toFixed(1) + '%';
    if (pe) pe.textContent = pct.toFixed(1) + '%';

    var s = _tf[peerId];
    if (s && se && chunks < total) {
        var elapsed = (now - (s._startTime || now)) / 1000;
        if (elapsed > 0.5) {
            var bytesDone = chunks * s.chunkSize;
            var speed = bytesDone / elapsed;
            var remaining = (total - chunks) * s.chunkSize;
            var eta = speed > 0 ? remaining / speed : 0;
            se.textContent = _fmtSize(speed) + '/s  剩余 ' + _fmtTime(eta);
        }
    }
    if (chunks >= total && se) {
        var e = s ? (now - (s._startTime || now)) / 1000 : 0;
        var avg = e > 0 ? (s ? s.fileSize / e : 0) : 0;
        se.textContent = '完成  ' + _fmtSize(avg) + '/s  耗时 ' + _fmtTime(e);
    }
}

function _hideProgress(peerId, delayMs) {
    if (_progHideTimer[peerId]) clearTimeout(_progHideTimer[peerId]);
    var fn = function () {
        var bar = _getBar(peerId);
        if (bar) bar.classList.add('hidden');
        delete _lastProgTime[peerId];
    };
    _progHideTimer[peerId] = delayMs > 0 ? setTimeout(fn, delayMs) : null;
    if (delayMs <= 0) fn();
}

function _getBar(peerId) {
    return document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"] .transfer-progress');
}

function _fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function _fmtSpeed(bytesPerSec) {
    return _fmtSize(bytesPerSec) + '/s';
}

function _fmtTime(sec) {
    if (sec < 1) return '不足1秒';
    if (sec < 60) return Math.ceil(sec) + '秒';
    if (sec < 3600) return Math.floor(sec / 60) + '分' + Math.ceil(sec % 60) + '秒';
    return Math.floor(sec / 3600) + '小时' + Math.floor((sec % 3600) / 60) + '分';
}

// ========================================================================
//  聊天 UI（保持原有逻辑）
// ========================================================================

function createPeerChatContainer(peerId) {
    var template = document.getElementById('transferTemplate');
    if (!template) return null;
    var tabs = document.getElementById('peerTabs');
    if (!tabs) return null;

    var existing = tabs.querySelector('.peer-chat-container[data-peerid="' + peerId + '"]');
    if (existing) return existing;

    var container = template.querySelector('.peer-chat-container').cloneNode(true);
    container.setAttribute('data-peerid', peerId);
    container.querySelector('.transfer-peer-id').textContent = peerId;

    container.querySelector('.chat-menu-toggle').onclick = function () {
        if (window.toggleSidebar) window.toggleSidebar();
    };

    var msgInput = container.querySelector('.message-input');
    var sendBtn  = container.querySelector('.send-msg-btn');
    var fileInput  = container.querySelector('.file-input');
    var fileLabel  = container.querySelector('.file-label-btn');

    sendBtn.onclick = function () {
        var text = msgInput.value.trim();
        if (!text) return;
        var conn = connections[peerId];
        if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
            addLog('[发送失败] 数据通道未就绪');
            return;
        }
        conn.dc.send(JSON.stringify({ type: 'chat', text: text }));
        addPeerMessage(peerId, 'self', text);
        msgInput.value = '';
    };
    msgInput.onkeypress = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.onclick(); }
    };

    fileLabel.onclick = function () { fileInput.click(); };
    fileInput.onchange = function () {
        if (fileInput.files.length) {
            var conn = connections[peerId];
            if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
                addLog('[发送失败] 数据通道未就绪');
                fileInput.value = '';
                return;
            }
            sendFileOverDC(conn.dc, fileInput.files[0], peerId);
            fileInput.value = '';
        }
    };

    tabs.appendChild(container);

    if (connections[peerId] && connections[peerId].messages) {
        var msgs = connections[peerId].messages;
        connections[peerId].messages = [];
        for (var m = 0; m < msgs.length; m++) {
            addPeerMessage(peerId, msgs[m].sender, msgs[m].text);
        }
    }
    return container;
}

function addPeerMessage(peerId, sender, text) {
    var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"]');
    if (!container) return;
    var msgList = container.querySelector('.transfer-messages');
    if (!msgList) return;

    var wrapper = document.createElement('div');
    if (sender === 'self') wrapper.className = 'message-wrapper self-msg';
    else if (sender === 'system') wrapper.className = 'message-wrapper system-msg';
    else wrapper.className = 'message-wrapper peer-msg';

    var bubble = document.createElement('div');
    bubble.className = 'message';
    bubble.textContent = text;
    wrapper.appendChild(bubble);
    msgList.appendChild(wrapper);

    var cc = container.querySelector('.chat-container');
    if (cc) cc.scrollTop = cc.scrollHeight;

    if (connections[peerId]) {
        if (!connections[peerId].messages) connections[peerId].messages = [];
        connections[peerId].messages.push({ sender: sender, text: text });
    }
}

// ========== 兼容旧版 ==========
function sendChatMessage() {
    if (!activePeerId) return;
    var c = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + activePeerId + '"]');
    if (c) { var b = c.querySelector('.send-msg-btn'); if (b) b.onclick(); }
}
function sendFile(file) {
    if (!activePeerId) return;
    var conn = connections[activePeerId];
    if (conn && conn.dc) sendFileOverDC(conn.dc, file, activePeerId);
}
function showTransferAssistant() { }
function addMessage(sender, text) { if (activePeerId) addPeerMessage(activePeerId, sender, text); }

// ========== 导出 ==========
window.createDataChannel            = createDataChannel;
window.setupDataChannelForPeer      = setupDataChannelForPeer;
window.sendFileOverDC               = sendFileOverDC;
window.createPeerChatContainer      = createPeerChatContainer;
window.addPeerMessage               = addPeerMessage;
window.sendChatMessage              = sendChatMessage;
window.sendFile                     = sendFile;
window.showTransferAssistant        = showTransferAssistant;
window.addMessage                   = addMessage;
window.tryResumeTransfer            = tryResumeTransfer;
