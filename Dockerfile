FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps ./apps
RUN npm install
RUN npm run build
EXPOSE 3000 5173
CMD ["npm", "run", "dev"]
