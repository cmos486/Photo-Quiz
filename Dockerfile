FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY index.html ./public/index.html
COPY tailwind.css ./public/tailwind.css

# Crear carpetas de datos y asignar permisos al usuario node
RUN mkdir -p /app/photos /app/data /app/audio && chown -R node:node /app/photos /app/data

EXPOSE 3001

# Ejecutar como usuario no-root
USER node

CMD ["node", "server.js"]
