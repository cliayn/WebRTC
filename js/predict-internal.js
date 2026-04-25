// 内网预测和网关爆破模块
// 依赖的全局变量：pc, targetId, localCandidates, gatewayBurstRange, maxGatewayAttempts, carrierNatDetectionEnabled, manualIpFallbackEnabled
// 依赖的全局函数：addLog, showModal, buildICECandidate

// 运营商NAT检测模式（可从carrier-nat-patterns.json或高级设置加载）
var carrierNatPatterns = [];           // 编译后的 RegExp 对象数组
var carrierNatPatternConfigs = [];     // 用户可配置的 { name, regex } 数组
var carrierNatPatternDefaults = [      // 默认配置（与 carrier-nat-patterns.json 同步）
    { name: '10.0.0.0/8',        regex: '^10\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$' },
    { name: '172.16.0.0/12',     regex: '^172\\.(?:1[6-9]|2[0-9]|3[0-1])\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$' },
    { name: '100.64.0.0/10',     regex: '^100\\.(?:6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$' }
];

// 初始化检测模式（从默认值加载）
function initCarrierNatPatterns() {
    carrierNatPatternConfigs = JSON.parse(JSON.stringify(carrierNatPatternDefaults));
    compileCarrierNatPatterns();
    if (typeof addLog === 'function') addLog('[内网预测] 已加载 ' + carrierNatPatterns.length + ' 条检测规则');
}

// 重新编译检测模式
function compileCarrierNatPatterns() {
    carrierNatPatterns = carrierNatPatternConfigs.map(function(c) {
        try { return new RegExp(c.regex); }
        catch(e) { console.error('[正则错误] ' + c.name + ': ' + e.message); return null; }
    }).filter(Boolean);
}

// 获取当前检测模式配置
function getCarrierNatPatterns() {
    return carrierNatPatternConfigs;
}

// 更新检测模式配置
function updateCarrierNatPatterns(newConfigs) {
    carrierNatPatternConfigs = newConfigs;
    compileCarrierNatPatterns();
    if (typeof addLog === 'function') addLog('[检测规则] 已更新 ' + carrierNatPatterns.length + ' 条检测规则');
}

// 从 JSON 文件加载检测模式
async function loadCarrierNatPatternsFromJson() {
    try {
        var resp = await fetch('assets/carrier-nat-patterns.json');
        var data = await resp.json();
        if (data.patterns && data.patterns.length > 0) {
            carrierNatPatternConfigs = data.patterns.map(function(p) {
                return { name: p.name || p.cidr, regex: p.regex };
            });
            compileCarrierNatPatterns();
            if (typeof addLog === 'function') addLog('[检测规则] 从文件加载 ' + carrierNatPatterns.length + ' 条规则');
        }
    } catch(e) {
        if (typeof addLog === 'function') addLog('[检测规则] 无法加载配置文件，使用默认规则');
    }
}

// 初始化默认模式
initCarrierNatPatterns();

// 检测IP是否为运营商NAT
function isCarrierNatIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    return carrierNatPatterns.some(pattern => pattern.test(ip));
}

// 解析网关爆破范围字符串 "192.168.1-255.1"
// 返回IP前缀和后缀范围数组
function parseGatewayRange(rangeStr) {
    // 格式: "192.168.1-255.1" 或 "192.168.1.1"
    const parts = rangeStr.split('.');
    if (parts.length !== 4) {
        addLog('[网关解析] 格式错误，应为4段: ' + rangeStr);
        return null;
    }

    const prefix = parts[0] + '.' + parts[1]; // "192.168"
    const thirdPart = parts[2]; // "1-255" 或 "1"
    const fourthPart = parts[3]; // "1"

    let start, end;
    if (thirdPart.includes('-')) {
        const [startStr, endStr] = thirdPart.split('-');
        start = parseInt(startStr, 10);
        end = parseInt(endStr, 10);
    } else {
        start = end = parseInt(thirdPart, 10);
    }

    if (isNaN(start) || isNaN(end) || start < 0 || start > 255 || end < 0 || end > 255) {
        addLog('[网关解析] 第三段范围无效: ' + thirdPart);
        return null;
    }

    const fourth = parseInt(fourthPart, 10);
    if (isNaN(fourth) || fourth < 0 || fourth > 255) {
        addLog('[网关解析] 第四段无效: ' + fourthPart);
        return null;
    }

    return {
        prefix: prefix,
        thirdStart: start,
        thirdEnd: end,
        fourth: fourth
    };
}

// 生成网关IP列表
function generateGatewayIps(rangeConfig) {
    const ips = [];
    const { prefix, thirdStart, thirdEnd, fourth } = rangeConfig;

    for (let third = thirdStart; third <= thirdEnd; third++) {
        ips.push(`${prefix}.${third}.${fourth}`);
        // 限制数量
        if (ips.length >= maxGatewayAttempts) break;
    }

    addLog(`[网关生成] 生成 ${ips.length} 个网关IP`);
    return ips;
}

// 为网关IP创建ICE候选并添加到PeerConnection
function addGatewayIceCandidates(gatewayIps, originalPort, ufrag) {
    if (!pc || !gatewayIps.length) return;

    addLog(`[网关ICE] 添加 ${gatewayIps.length} 个网关候选，端口: ${originalPort}（仅本端使用，不发送给对方）`);

    gatewayIps.forEach(ip => {
        // 创建host类型的ICE候选
        const candidateStr = buildICECandidate(ip, originalPort, 'host', ufrag);
        const candidate = new RTCIceCandidate({
            candidate: candidateStr,
            sdpMid: '0',
            sdpMLineIndex: 0
        });

        try {
            pc.addIceCandidate(candidate);
            addLog(`[网关ICE] 添加候选: ${ip}:${originalPort}`);
            // 注意：这些网关IP候选仅在自己端添加，不发送给对方
            // 因为对方可能在内网，使用运营商NAT地址，我们尝试猜测其网关IP

            // 更新候选状态
            if (window.gatewayCandidateStatus) {
                window.gatewayCandidateStatus[ip] = { status: 'added', time: Date.now() };
            }
            // 更新状态显示
            if (window.updateGatewayStatusDisplay) {
                window.updateGatewayStatusDisplay();
            }
        } catch (err) {
            addLog(`[网关ICE错误] ${ip}: ${err.message}`);
            if (window.gatewayCandidateStatus) {
                window.gatewayCandidateStatus[ip] = { status: 'failed', time: Date.now(), error: err.message };
            }
            // 更新状态显示
            if (window.updateGatewayStatusDisplay) {
                window.updateGatewayStatusDisplay();
            }
        }
    });
}

// 实时运营商NAT替换：检测到运营商NAT IP后立即建立IP替换映射
// 后续所有ICE候选中的该IP将被replaceIceCandidateIp自动替换为网关IP
// 不再添加平行候选，而是直接替换，类似旧版爆破逻辑
function setupRealtimeReplacement(carrierNatIp) {
    if (!carrierNatDetectionEnabled) return null;

    var rangeConfig = parseGatewayRange(gatewayBurstRange);
    if (!rangeConfig) { addLog('[实时替换] 网关范围解析失败'); return null; }

    var gatewayIps = generateGatewayIps(rangeConfig);
    if (!gatewayIps.length) { addLog('[实时替换] 无网关IP生成'); return null; }

    var replacementIp = gatewayIps[0];
    carrierNatReplacementMap[carrierNatIp] = replacementIp;
    addLog('[实时替换] ' + carrierNatIp + ' → ' + replacementIp + '（原IP丢弃）');
    return replacementIp;
}

// 旧版实时爆破函数（已废弃，保留兼容）
function triggerRealtimeGatewayBurst(carrierNatIp, remotePort, remoteCandidateStr) {
    return setupRealtimeReplacement(carrierNatIp) !== null;
}

// 检测对方IP并触发网关爆破
// remoteIps: 对方IP数组（从ICE候选中提取）
// remotePort: 对方端口（通常所有候选端口相同）
// ufrag: ICE用户名片段
function triggerGatewayBurst(remoteIps, remotePort, ufrag) {
    if (!carrierNatDetectionEnabled) {
        addLog('[网关爆破] 运营商NAT检测已禁用');
        return false;
    }

    // 检查是否有运营商NAT IP
    const carrierNatIp = remoteIps.find(ip => isCarrierNatIp(ip));
    if (!carrierNatIp) {
        addLog('[网关爆破] 未检测到运营商NAT IP');
        return false;
    }

    addLog(`[网关爆破] 检测到运营商NAT IP: ${carrierNatIp}`);

    // 解析网关范围
    const rangeConfig = parseGatewayRange(gatewayBurstRange);
    if (!rangeConfig) {
        addLog('[网关爆破] 网关范围解析失败');
        return false;
    }

    // 生成网关IP
    const gatewayIps = generateGatewayIps(rangeConfig);
    if (!gatewayIps.length) {
        addLog('[网关爆破] 无网关IP生成');
        return false;
    }

    // 添加ICE候选
    addGatewayIceCandidates(gatewayIps, remotePort, ufrag);
    return true;
}

// 手动IP回退：弹窗让用户输入对端内网IP
async function manualIpFallback(detectedCarrierNatIp, remotePort, ufrag) {
    if (!manualIpFallbackEnabled) return null;

    addLog('[手动回退] 启动手动IP回退');

    const userInput = await showModal(
        '手动指定内网IP',
        `检测到对方IP ${detectedCarrierNatIp} 为运营商NAT地址，自动网关爆破失败。\n\n` +
        `请手动输入对方的内网IP地址（例如 192.168.1.100）：`
    );

    if (userInput === false) return null; // 用户取消

    // 用户输入的是字符串 true（确认），但我们需要文本输入框
    // 由于现有showModal只有确认/取消，我们需要扩展或创建新的输入模态框
    // 暂时简化：使用prompt
    try {
        const ip = prompt(`请输入对方的内网IP地址（当前端口: ${remotePort}）:`, '192.168.1.100');
        if (!ip) return null;

        // 简单验证IP格式
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipRegex.test(ip)) {
            alert('IP地址格式无效');
            return null;
        }

        // 创建ICE候选
        const candidateStr = buildICECandidate(ip, remotePort, 'host', ufrag);
        const candidate = new RTCIceCandidate({
            candidate: candidateStr,
            sdpMid: '0',
            sdpMLineIndex: 0
        });

        pc.addIceCandidate(candidate);
        addLog(`[手动回退] 添加手动IP候选: ${ip}:${remotePort}`);
        // 注意：手动输入的IP候选仅在自己端添加，不发送给对方
        // 因为对方可能在内网，使用运营商NAT地址，我们尝试猜测其内网IP

        return ip;
    } catch (err) {
        addLog(`[手动回退错误] ${err.message}`);
        return null;
    }
}

// 提取远程ICE候选中的IP和端口
function extractRemoteIpsAndPort(remoteCandidates) {
    const ips = new Set();
    let port = null;

    remoteCandidates.forEach(candidateStr => {
        // 解析ICE候选字符串，格式: "candidate:... udp ... IP PORT typ ..."
        const parts = candidateStr.split(' ');
        if (parts.length < 8) return;

        const ip = parts[4];
        const candidatePort = parseInt(parts[5], 10);

        if (ip && !ip.includes(':')) { // 忽略IPv6
            ips.add(ip);
            if (port === null && !isNaN(candidatePort)) {
                port = candidatePort;
            }
        }
    });

    return {
        ips: Array.from(ips),
        port: port
    };
}

// 初始化模块
function initInternalPrediction() {
    addLog('[内网预测] 模块初始化完成');
}

// 导出全局函数
window.isCarrierNatIp = isCarrierNatIp;
window.parseGatewayRange = parseGatewayRange;
window.generateGatewayIps = generateGatewayIps;
window.addGatewayIceCandidates = addGatewayIceCandidates;
window.triggerGatewayBurst = triggerGatewayBurst;
window.setupRealtimeReplacement = setupRealtimeReplacement;
window.triggerRealtimeGatewayBurst = triggerRealtimeGatewayBurst;
window.manualIpFallback = manualIpFallback;
window.extractRemoteIpsAndPort = extractRemoteIpsAndPort;
window.initInternalPrediction = initInternalPrediction;
window.getCarrierNatPatterns = getCarrierNatPatterns;
window.updateCarrierNatPatterns = updateCarrierNatPatterns;
window.loadCarrierNatPatternsFromJson = loadCarrierNatPatternsFromJson;
window.compileCarrierNatPatterns = compileCarrierNatPatterns;