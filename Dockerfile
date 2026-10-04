FROM node:22-alpine
WORKDIR /app
COPY package.json server.js build.js ./
COPY src ./src
# Rebuilds public/index.html and checks that server.js matches the questionnaire.
RUN node build.js
# The volume must belong to the "node" user, otherwise the server cannot write to it.
RUN mkdir -p /data && chown node:node /data
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
