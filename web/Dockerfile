# The live page. Node builds it, nginx serves the files that come out.

# The source and its tools. The tests of the page run in this stage.
FROM node:24-alpine AS source
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Type check, then build into /web/dist.
FROM source AS build
RUN npm run build

# The image that runs: nginx and the built files, no Node.
FROM nginx:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
