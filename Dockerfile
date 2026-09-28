# AC711 Cloud — สำหรับ VPS/คลาวด์ทั่วไป (Docker)
# build:  docker build -t ac711 .
# run:    docker run -d --name ac711 --restart unless-stopped -p 3000:3000 -v ac711-data:/var/data --env-file .env ac711
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/var/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
VOLUME ["/var/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
