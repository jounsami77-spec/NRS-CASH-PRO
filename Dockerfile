FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY server.js bootstrap.js ./
COPY public ./public

RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 8080

CMD ["sh", "-c", "node bootstrap.js && exec node server.js"]
