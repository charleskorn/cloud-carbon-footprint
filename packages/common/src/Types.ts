/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  BaseExternalAccountClient,
  Compute,
  JWT,
  UserRefreshClient,
  Impersonated,
} from 'google-auth-library'

export type GoogleAuthClient =
  | Compute
  | JWT
  | UserRefreshClient
  | Impersonated
  | BaseExternalAccountClient

export interface TagCollection {
  [index: string]: string
}
