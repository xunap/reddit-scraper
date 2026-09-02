# Официалният Playwright образ вече съдържа Chromium + всички системни
# зависимости, инсталирани и кеширани - това е единственият надежден начин
# да пуснеш Playwright в контейнер без ръчно инсталиране на десетки apt пакети.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
