FROM oven/bun:1.3-alpine

WORKDIR /app

COPY src ./src
COPY public ./public
COPY package.json tsconfig.json ./

RUN mkdir -p /cache /data && chown -R bun:bun /cache /data

ENV PORT=3000 \
    CACHE_DIR=/cache \
    DATA_DIR=/data

USER bun

EXPOSE 3000

CMD ["bun", "src/server.ts"]
