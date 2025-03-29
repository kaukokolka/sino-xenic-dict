# specify the node base image with your desired version node:<version>
FROM node:23.10.0
WORKDIR /app
ADD . /app/
COPY package*.json ./
RUN npm install
RUN npm install sqlite3
EXPOSE 8080
# Run the app
CMD [ "npm", "start" ]
