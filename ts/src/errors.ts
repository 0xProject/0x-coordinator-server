// tslint:disable:max-classes-per-file
export abstract class CoordinatorBaseError extends Error {
    public abstract statusCode: number;
    public isCoordinatorError = true;
}

export abstract class BadRequestError extends CoordinatorBaseError {
    public statusCode = 400;
    public abstract generalErrorCode: GeneralErrorCodes;
}

export interface ValidationErrorItem {
    field: string;
    code: ValidationErrorCodes;
    reason: string;
}

export class ValidationError extends BadRequestError {
    public generalErrorCode = GeneralErrorCodes.ValidationError;
    public validationErrors: ValidationErrorItem[];
    constructor(validationErrors: ValidationErrorItem[]) {
        super();
        this.validationErrors = validationErrors;
    }
}

export class MalformedJSONError extends BadRequestError {
    public generalErrorCode = GeneralErrorCodes.MalformedJson;
}

export class NotFoundError extends CoordinatorBaseError {
    public statusCode = 404;
}

export class TooManyRequestsError extends CoordinatorBaseError {
    public statusCode = 429;
    public generalErrorCode = GeneralErrorCodes.Throttled;
}

export class InternalServerError extends CoordinatorBaseError {
    public statusCode = 500;
}

export class NotImplementedError extends CoordinatorBaseError {
    public statusCode = 501;
}

export enum GeneralErrorCodes {
    ValidationError = 100,
    MalformedJson = 101,
    Throttled = 103,
}

export const generalErrorCodeToReason: { [key in GeneralErrorCodes]: string } = {
    [GeneralErrorCodes.ValidationError]: 'Validation Failed',
    [GeneralErrorCodes.MalformedJson]: 'Malformed JSON',
    [GeneralErrorCodes.Throttled]: 'Throttled',
};

export enum ValidationErrorCodes {
    RequiredField = 1000,
    IncorrectFormat = 1001,
    InvalidAddress = 1002,
    AddressNotSupported = 1003,
    ValueOutOfRange = 1004,
    InvalidSignatureOrHash = 1005,
    UnsupportedOption = 1006,
    InvalidOrder = 1007,
}
