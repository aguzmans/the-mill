# syntax=docker/dockerfile:1
# Build the static prototype and serve it via nginx.
# Build context is apps/web:  docker build -t mill-web apps/web

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
# MILL_MODE=live builds the dynamic UI (talks to the api via nginx's /api proxy).
# Build with --build-arg MILL_MODE=mock for the standalone static prototype.
ARG MILL_MODE=live
ENV VITE_MILL_MODE=$MILL_MODE
RUN npm run build

# ---- serve ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
