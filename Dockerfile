FROM node:20-alpine

WORKDIR /app

# Install deps first (better layer cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app source
COPY server.js ./
COPY public ./public

# Persistent data lives outside the image — Coolify will mount a volume here
VOLUME ["/data"]
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
