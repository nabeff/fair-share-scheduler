# Node builds the page, nginx serves it.

# The page tests run in this stage.
FROM node:24-alpine AS source
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

FROM source AS build
RUN npm run build

FROM nginx:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
