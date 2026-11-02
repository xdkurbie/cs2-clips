FROM node:22.14.0-bookworm-slim AS ui
WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci
COPY frontend frontend
RUN npm run build -w frontend

FROM node:22.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip bzip2 ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend backend
COPY parser parser
COPY shared shared
RUN npm ci --omit=dev -w backend \
  && pip3 install --break-system-packages --no-cache-dir -r parser/requirements.txt
COPY --from=ui /src/frontend/dist frontend/dist
ENV PORT=8787 HOST=0.0.0.0 DATA_DIR=/tmp/cs2clips PYTHON=python3
EXPOSE 8787
CMD ["node", "backend/src/index.js"]
