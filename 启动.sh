#!/usr/bin/env bash
# 工行积存金实盘跟踪 · 一键启动（macOS / Linux）
# 用法： ./启动.sh [端口]     例： ./启动.sh 9000
# 停止： Ctrl+C
set -u
cd "$(dirname "$0")" || exit 1

PORT="${1:-8765}"
echo
echo "============================================================"
echo " 工行积存金实盘跟踪 · 一键启动"
echo " 访问地址  http://127.0.0.1:${PORT}"
echo " 后台持续采集：关闭网页也会继续记录，请保持此窗口开启"
echo "============================================================"
echo

# 依次尝试 python3 / python，要求 >= 3.8
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c 'import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)' >/dev/null 2>&1; then
      PY="$c"; break
    fi
  fi
done

if [ -z "$PY" ]; then
  echo "[错误] 未找到 Python 3.8+。"
  echo "  macOS  :  brew install python@3.12    或  https://www.python.org/downloads/"
  echo "  Ubuntu :  sudo apt install python3"
  echo "  CentOS :  sudo dnf install python3"
  exit 1
fi

echo "[OK] Python: $PY  ($($PY --version 2>&1))"

# 依赖检查：pymysql + cryptography（缺失自动安装）
if ! "$PY" -c 'import pymysql, cryptography' >/dev/null 2>&1; then
  echo "[INFO] 正在安装 pymysql + cryptography ..."
  "$PY" -m pip install pymysql cryptography --quiet || {
    echo "[错误] 依赖安装失败，请手动运行: $PY -m pip install pymysql cryptography"
    exit 1
  }
fi
echo "[OK] Python 依赖: pymysql + cryptography"

# MySQL 可达性检查
if ! "$PY" -c '
import json, os, pymysql
c = json.load(open("db_config.json", encoding="utf-8")) if os.path.exists("db_config.json") else {}
m = pymysql.connect(host=c.get("host","127.0.0.1"), port=int(c.get("port",3306)),
                    user=c.get("user","root"), password=c.get("password","123456"), connect_timeout=4)
m.close()
' >/dev/null 2>&1; then
  echo "[错误] 无法连接 MySQL（默认 root/123456 @ 127.0.0.1:3306）。"
  echo "  1. 确认 MySQL 服务已启动；2. 检查 db_config.json 的连接参数。"
  exit 1
fi
echo "[OK] MySQL 可连接"

echo "正在启动服务…… 按 Ctrl+C 停止。"
echo "------------------------------------------------------------"

# 延迟 1.5 秒再打开浏览器，等服务完成首次抓取
( sleep 1.5
  if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:${PORT}/"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:${PORT}/"
  fi
) >/dev/null 2>&1 &

exec "$PY" server.py --port "$PORT"
