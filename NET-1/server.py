#!/usr/bin/env python3
# signaling_server.py
# 支持内网探查的轻量信令服务器

import asyncio
import json
import logging
import argparse
from collections import defaultdict
from websockets.server import serve
from websockets.exceptions import ConnectionClosed

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)

class SignalingServer:
    def __init__(self):
        self.clients = {}                     # client_id -> websocket
        self.client_info = {}                 # client_id -> {"public_ip": str, "public_port": int}
        self.public_ip_groups = defaultdict(list)  # public_ip -> [client_id, ...]
        self.counter = 0

    async def handler(self, websocket):
        client_id = str(self.counter)
        self.counter += 1
        self.clients[client_id] = websocket
        logging.info(f"[连接] 客户端已连接，分配 ID: {client_id}")

        try:
            await websocket.send(json.dumps({"type": "ok", "id": client_id}))

            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    logging.warning(f"[错误] 无效 JSON: {message}")
                    continue

                msg_type = data.get("type")
                target_id = data.get("target")
                payload = data.get("payload")

                logging.debug(f"[接收] 来自 {client_id} -> 目标 {target_id}: type={msg_type}")

                # ---- 内网探查相关 ----
                if msg_type == "report_public":
                    public_ip = payload.get("public_ip")
                    public_port = payload.get("public_port")
                    self.client_info[client_id] = {"public_ip": public_ip, "public_port": public_port}
                    self.public_ip_groups[public_ip].append(client_id)
                    logging.info(f"[探查] 客户端 {client_id} 公网地址: {public_ip}:{public_port}")
                    
                    # 返回同公网IP的其他客户端列表
                    same_ip_clients = [cid for cid in self.public_ip_groups[public_ip] if cid != client_id]
                    await websocket.send(json.dumps({
                        "type": "same_network_clients",
                        "clients": same_ip_clients
                    }))
                    # 通知同组其他客户端
                    for cid in same_ip_clients:
                        if cid in self.clients:
                            await self.clients[cid].send(json.dumps({
                                "type": "new_peer",
                                "peer_id": client_id
                            }))

                # ---- 标准信令转发（压缩格式）----
                elif msg_type in ("offer", "answer", "ice"):
                    if target_id and target_id in self.clients:
                        forward_msg = {
                            "type": msg_type,
                            "from": client_id,
                            "payload": payload
                        }
                        await self.clients[target_id].send(json.dumps(forward_msg))
                        logging.info(f"[转发] {msg_type} 从 {client_id} 到 {target_id}")
                    else:
                        logging.warning(f"[警告] 目标 {target_id} 不存在")
                        await websocket.send(json.dumps({"type": "error", "msg": f"目标 {target_id} 不存在"}))

                elif msg_type == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))

                elif msg_type == "get_id":
                    await websocket.send(json.dumps({"type": "id", "id": client_id}))

                # 在现有handler中添加对 "connect_request" 和 "connect_accept" 的处理
                elif msg_type == "connect_request":
                    # 主动方请求连接
                    if target_id and target_id in self.clients:
                        forward_msg = {
                            "type": "connect_request",
                            "from": client_id,
                            "payload": payload  # 可包含主动方公网信息等
                        }
                        await self.clients[target_id].send(json.dumps(forward_msg))
                        logging.info(f"[连接请求] {client_id} -> {target_id}")
                    else:
                        await websocket.send(json.dumps({"type": "error", "msg": f"目标 {target_id} 不存在"}))
                
                elif msg_type == "connect_accept":
                    # 被动方接受连接
                    if target_id and target_id in self.clients:
                        forward_msg = {
                            "type": "connect_accept",
                            "from": client_id
                        }
                        await self.clients[target_id].send(json.dumps(forward_msg))
                        logging.info(f"[接受连接] {client_id} 接受 {target_id}")

                else:
                    logging.warning(f"[未知] 未知消息类型: {msg_type}")

        except ConnectionClosed:
            logging.info(f"[断开] 客户端 {client_id} 断开连接")
        finally:
            if client_id in self.clients:
                del self.clients[client_id]
            info = self.client_info.pop(client_id, None)
            if info:
                public_ip = info["public_ip"]
                if client_id in self.public_ip_groups[public_ip]:
                    self.public_ip_groups[public_ip].remove(client_id)
                    if not self.public_ip_groups[public_ip]:
                        del self.public_ip_groups[public_ip]
                for cid in self.public_ip_groups.get(public_ip, []):
                    if cid in self.clients:
                        await self.clients[cid].send(json.dumps({
                            "type": "peer_left",
                            "peer_id": client_id
                        }))
            logging.info(f"[清理] 客户端 {client_id} 已移除")

async def main(host, port):
    server = SignalingServer()
    async with serve(server.handler, host, port):
        logging.info(f"信令服务器运行在 ws://{host}:{port}")
        await asyncio.Future()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8800)
    args = parser.parse_args()
    asyncio.run(main(args.host, args.port))