# Keykin Storage as a container. Built from the repo root:
#   docker build -f deploy/Dockerfile -t keykin-storage .
#
# The town list for `POST /places` `names` is built here, at image build time, from GeoNames (CC BY 4.0): the box
# never fetches it. /app/towns/SOURCE records the download date, the sha256 of every input and of the list, and the
# licence line. To pin the inputs, pass the sums from an earlier SOURCE:
#   --build-arg CITIES_SHA256=<cities500.zip> --build-arg ADMIN1_SHA256=<admin1CodesASCII.txt> --build-arg COUNTRIES_SHA256=<countryInfo.txt>
# GEONAMES_URL points the build at another copy of the same three files.

FROM node:24-alpine AS towns
ARG GEONAMES_URL=https://download.geonames.org/export/dump
ARG CITIES_SHA256=
ARG ADMIN1_SHA256=
ARG COUNTRIES_SHA256=
WORKDIR /build
COPY scripts/towns.ts ./scripts/towns.ts
RUN set -eu; \
    mkdir in out; \
    for f in cities500.zip admin1CodesASCII.txt countryInfo.txt; do wget -q -O "in/$f" "$GEONAMES_URL/$f"; done; \
    check() { if [ -n "$2" ]; then echo "$2  in/$1" | sha256sum -c -; fi; }; \
    check cities500.zip "$CITIES_SHA256"; check admin1CodesASCII.txt "$ADMIN1_SHA256"; check countryInfo.txt "$COUNTRIES_SHA256"; \
    unzip -q -d in in/cities500.zip cities500.txt; \
    NODE_NO_WARNINGS=1 node scripts/towns.ts in out; \
    cat out/SOURCE

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=towns /build/out ./towns
ENV STORAGE_DIR=/data STORAGE_ADDR=0.0.0.0 STORAGE_PORT=7480 NODE_NO_WARNINGS=1
USER 1000:1000
EXPOSE 7480
CMD ["node", "src/main.ts"]
