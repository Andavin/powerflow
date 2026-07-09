FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /span-collector .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /span-collector /app/

VOLUME ["/config"]
WORKDIR /app
ENTRYPOINT ["/app/span-collector"]
CMD ["-config", "/config/config.yml"]
