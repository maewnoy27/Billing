# ───────── ระบบวางบิล & เก็บเงิน (Billing & Payment System) ─────────
FROM node:20-bookworm-slim

# build tools สำหรับคอมไพล์ better-sqlite3 (เผื่อกรณีไม่มี prebuilt binary)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ติดตั้ง dependencies ก่อน (cache layer)
COPY package*.json ./
RUN npm install --omit=dev

# คัดลอกซอร์สโค้ดทั้งหมด
COPY . .

# Render/แพลตฟอร์มจะกำหนด PORT ผ่าน env ให้เอง (server อ่าน process.env.PORT)
EXPOSE 10000

CMD ["node", "billing-server.js"]
