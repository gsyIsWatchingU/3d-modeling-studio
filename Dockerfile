FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data/uploads /data/models

EXPOSE 3000

CMD ["node", "server/index.js"]
