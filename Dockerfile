# One image for every process: API, scheduler, worker, migration, tests and load test.
# Node 24 runs TypeScript files directly, so there is no build step.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["node", "src/api.ts"]
