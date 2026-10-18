targetScope = 'subscription'

@minLength(1)
@maxLength(64)
param environmentName string

@minLength(1)
param location string

param sessionId string
param deployedBy string
param createdAt string
param deployerObjectId string

var tags = {
  'app-onboard-skill': 'true'
  'app-onboard-session-id': sessionId
  'created-at': createdAt
  environment: environmentName
  'deployed-by': deployedBy
}

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module appServicePlan './modules/app-service-plan.bicep' = {
  name: 'app-service-plan'
  scope: rg
  params: {
    location: location
    tags: tags
    planName: 'asp-clario-dev-42e4'
  }
}

module api './modules/app-service.bicep' = {
  name: 'api'
  scope: rg
  params: {
    location: location
    tags: tags
    appServicePlanId: appServicePlan.outputs.resourceId
    appServiceName: 'app-clario-dev-42e4'
  }
}

module teacher './modules/static-web-app.bicep' = {
  name: 'teacher'
  scope: rg
  params: {
    location: 'eastasia'
    tags: tags
    staticWebAppName: 'swa-teacher-clario-dev-42e4'
  }
}

module student './modules/static-web-app.bicep' = {
  name: 'student'
  scope: rg
  params: {
    location: 'eastasia'
    tags: tags
    staticWebAppName: 'swa-student-clario-dev-42e4'
  }
}

module deploymentIdentity './modules/deployment-identity.bicep' = {
  name: 'deployment-identity'
  scope: rg
  params: {
    location: location
    tags: tags
    identityName: 'id-clario-dev-42e4'
  }
}

module roleAssignments './modules/role-assignments.bicep' = {
  name: 'role-assignments'
  scope: rg
  params: {
    principalId: deploymentIdentity.outputs.principalId
  }
}
