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

export enum GeneralErrorCodes {
    ValidationError = 100,
    MalformedJson = 101,
}

export const generalErrorCodeToReason: { [key in GeneralErrorCodes]: string } = {
    [GeneralErrorCodes.ValidationError]: 'Validation Failed',
    [GeneralErrorCodes.MalformedJson]: 'Malformed JSON',
};

export enum ValidationErrorCodes {
    RequiredField = 1000,
    IncorrectFormat = 1001,
    ValueOutOfRange = 1002,
    UnsupportedOption = 1003,
    IncludedOrderAlreadySoftCancelled = 1004,
    ZeroExTransactionDecodingFailed = 1005,
    NoCoordinatorOrdersIncluded = 1006,
    InvalidZeroExTransactionSignature = 1007,
    OnlyMakerCanCancelOrders = 1008,
    FunctionCallUnsupported = 1009,
    FillRequestsExceededTakerAssetAmount = 1010,
}
