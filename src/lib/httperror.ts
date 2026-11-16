/** An error with an HTTP status and a message written for the person using the app. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
