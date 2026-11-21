# Keykin Storage as a container. Built from the repo root:
#   docker build -f deploy/Dockerfile -t keykin-storage .
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV STORAGE_DIR=/data STORAGE_ADDR=0.0.0.0 STORAGE_PORT=7480 NODE_NO_WARNINGS=1
USER 1000:1000
EXPOSE 7480
CMD ["node", "src/main.ts"]
