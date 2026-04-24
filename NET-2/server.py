#!/usr/bin/env python3
# signaling_server.py
# 支持内网探查的轻量信令服务器（房间号版）

import asyncio
import json
import logging
import argparse
import random
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
        self.client_info = {}                 # client_id -> {"room_id": str, "conn_ip": str}
        self.room_groups = defaultdict(list)  # room_key -> [client_id, ...]
        self.available_ids = set()            # 可重用的ID池
        self._generate_initial_ids()

    def _generate_initial_ids(self):
        """生成初始的ID池"""
        # 使用4位字母数字组合，生成1000个初始ID
        chars = "abcdefghjkmnpqrstuvwxyz23456789"  # 去掉了易混淆的字符
        for _ in range(1000):
            id_str = ''.join(random.choices(chars, k=4))
            self.available_ids.add(id_str)

    def _generate_new_id(self):
        """生成新的ID，优先从可用池中获取"""
        if self.available_ids:
            return self.available_ids.pop()
        # 如果池子空了，生成一个新的
        chars = "abcdefghjkmnpqrstuvwxyz23456789"
        return ''.join(random.choices(chars, k=4))

    def _release_id(self, client_id):
        """释放ID到可用池"""
        self.available_ids.add(client_id)

    def _get_room_key(self, room_id, conn_ip):
        """获取房间分组键：有房间号用房间号，没有则用连接IP"""
        if room_id:
            return f"room:{room_id}"
        else:
            return f"ip:{conn_ip}"

    def _remove_from_group(self, client_id):
        """从房间组中移除客户端"""
        info = self.client_info.pop(client_id, None)
        if info:
            room_key = self._get_room_key(info["room_id"], info["conn_ip"])
            if client_id in self.room_groups[room_key]:
                self.room_groups[room_key].remove(client_id)
                if not self.room_groups[room_key]:
                    del self.room_groups[room_key]
            # 通知同组其他客户端
            for cid in self.room_groups.get(room_key, []):
                if cid in self.clients:
                    asyncio.ensure_future(
                        self.clients[cid].send(json.dumps({
                            "type": "peer_left",
                            "peer_id": client_id
                        }))
                    )

    async def handler(self, websocket):
        client_id = self._generate_new_id()
        self.clients[client_id] = websocket
        # 获取WebSocket连接的真实IP
        conn_ip = websocket.remote_address[0] if websocket.remote_address else "unknown"
        logging.info(f"[连接] 客户端已连接，分配 ID: {client_id}，连接IP: {conn_ip}")

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

                # ---- 房间号加入/更新 ----
                if msg_type == "join_room":
                    room_id = (payload.get("room_id") or "").strip() if payload else ""
                    self.client_info[client_id] = {"room_id": room_id, "conn_ip": conn_ip}

                    room_key = self._get_room_key(room_id, conn_ip)
                    if client_id not in self.room_groups[room_key]:
                        self.room_groups[room_key].append(client_id)

                    logging.info(f"[房间] 客户端 {client_id} 加入房间键: {room_key} (房间号: '{room_id}', 连接IP: {conn_ip})")

                    # 返回同房间/同IP的其他客户端列表
                    same_group_clients = [cid for cid in self.room_groups[room_key] if cid != client_id]
                    await websocket.send(json.dumps({
                        "type": "same_network_clients",
                        "clients": same_group_clients
                    }))
                    # 通知同组其他客户端
                    for cid in same_group_clients:
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

                elif msg_type == "connect_request":
                    # 主动方请求连接
                    if target_id and target_id in self.clients:
                        forward_msg = {
                            "type": "connect_request",
                            "from": client_id,
                            "payload": payload
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
            self._remove_from_group(client_id)
            # 释放ID到可用池
            self._release_id(client_id)
            logging.info(f"[清理] 客户端 {client_id} 已移除，ID已释放")

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
