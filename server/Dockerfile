# Build context is the repo root (see docker-compose.yml) so we can copy
# db/ and web/ alongside the server. TypeScript runs directly via tsx —
# no compile step, so there is no dist/ to drift out of sync.
FROM node:20-alpine

WORKDIR /app/server

COPY server/package.json ./
RUN npm install --omit=dev

COPY server/tsconfig.json ./
COPY server/src ./src
COPY db /app/db
COPY web /app/web

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
