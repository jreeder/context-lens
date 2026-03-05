export { handle };

function handle(event, context, callback) {
  const path = event.path || "/";
  const query =
    event.queryStringParameters &&
    Object.keys(event.queryStringParameters).length > 0
      ? "?" + new URLSearchParams(event.queryStringParameters).toString()
      : "";
  callback(null, {
    statusCode: 301,
    headers: { Location: `https://www.contextlens.io${path}${query}` },
    body: "",
  });
}
