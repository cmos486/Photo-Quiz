FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY index.html ./public/index.html

# Crear carpetas de datos (los bind mounts las sobreescriben en runtime)
RUN mkdir -p /app/photos /app/data

EXPOSE 3001

CMD ["node", "server.js"]
