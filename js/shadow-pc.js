// Shadow PC 预热模块
// 在雷达模式下提前创建隐藏的RTCPeerConnection收集host和srflx候选并缓存
// 依赖全局变量：stunServer, shadowPcActive, _shadowCandidateCache, shadowPcTimer
// 依赖全局函数：addLog

var SHADOW_REFRESH_INTERVAL = 30000; // 30秒刷新

// 启动Shadow PC预热循环
function shadowPcStart() {
    if (shadowPcActive) return;
    shadowPcActive = true;
    if (typeof addLog === 'function') addLog('[Shadow PC] 启动预热（每' + (SHADOW_REFRESH_INTERVAL / 1000) + '秒刷新）');
    _shadowPcRefresh();
}

// 停止Shadow PC预热循环
function shadowPcStop() {
    shadowPcActive = false;
    if (shadowPcTimer !== null) {
        clearTimeout(shadowPcTimer);
        shadowPcTimer = null;
    }
    _shadowCandidateCache = [];
    if (typeof addLog === 'function') addLog('[Shadow PC] 已停止');
}

// 内部：单次刷新周期
async function _shadowPcRefresh() {
    if (!shadowPcActive) return;

    var tempPc;
    try {
        var iceServers = stunServer ? [{ urls: stunServer }] : [];
        tempPc = new RTCPeerConnection({ iceServers: iceServers });

        // 创建临时DataChannel触发ICE收集
        var tempDc = tempPc.createDataChannel('shadowPreWarm');
        var candidates = [];

        tempPc.onicecandidate = function (e) {
            if (e.candidate) {
                var parts = e.candidate.candidate.split(' ');
                var typIdx = parts.indexOf('typ');
                if (typIdx > 1) {
                    var type = parts[typIdx + 1];
                    // 仅缓存 host 和 srflx（relay/prflx 因PC而异，不缓存）
                    if (type === 'host' || type === 'srflx') {
                        var port = parseInt(parts[typIdx - 1], 10);
                        if (port >= 1024) {
                            candidates.push({
                                ip: parts[typIdx - 2],
                                port: port,
                                type: type
                            });
                        }
                    }
                }
            }
        };

        var offer = await tempPc.createOffer();
        await tempPc.setLocalDescription(offer);

        // 等待ICE收集完成（最长3秒超时）
        await new Promise(function (resolve) {
            var timeout = setTimeout(function () {
                resolve();
            }, 3000);
            var check = function () {
                if (tempPc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                } else if (!shadowPcActive) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });

        // 去重：按 ip+type 保留最新记录
        var deduped = [];
        var seen = {};
        for (var ci = candidates.length - 1; ci >= 0; ci--) {
            var key = candidates[ci].ip + '|' + candidates[ci].type;
            if (!seen[key]) {
                seen[key] = true;
                deduped.unshift(candidates[ci]);
            }
        }

        _shadowCandidateCache = deduped;
        if (typeof addLog === 'function') {
            var hostCount = deduped.filter(function (c) { return c.type === 'host'; }).length;
            var srflxCount = deduped.filter(function (c) { return c.type === 'srflx'; }).length;
            addLog('[Shadow PC] 缓存 ' + deduped.length + ' 个候选 (host=' + hostCount + ', srflx=' + srflxCount + ')');
        }
    } catch (err) {
        if (typeof addLog === 'function') addLog('[Shadow PC] 刷新失败: ' + err.message);
    } finally {
        // 清理临时PC
        if (tempPc) {
            try { tempPc.close(); } catch (e) { }
        }
    }

    // 安排下次刷新
    if (shadowPcActive) {
        shadowPcTimer = setTimeout(_shadowPcRefresh, SHADOW_REFRESH_INTERVAL);
    }
}

// 获取缓存的影子候选（浅拷贝）
function getShadowCandidates() {
    return _shadowCandidateCache.slice();
}

// 导出
window.shadowPcStart = shadowPcStart;
window.shadowPcStop = shadowPcStop;
window._shadowPcRefresh = _shadowPcRefresh;
window.getShadowCandidates = getShadowCandidates;
