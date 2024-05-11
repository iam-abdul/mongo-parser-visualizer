import { parse } from "acorn";
import fs from "fs";
/*
 * i will follow this format
 *    {
 *      model: string,
 *      schema:{
 *          key: string
 *    }
 *}
 */

const onlyDevLog = (message) => {
  if (process.env.NODE_ENV === "dev") {
    console.log(message);
  }
};

const traverseMemberExpressionValue = (expressions) => {
  const propertName = expressions.property.name;
  let objectName = "";
  if (expressions.object.type === "MemberExpression") {
    objectName = traverseMemberExpressionValue(expressions.object);
  } else {
    objectName = expressions.object.name;
  }
  return `${objectName}.${propertName}`;
};

function traverseArguments(args, programBody, nodeId) {
  let result = {};

  args.forEach((arg) => {
    if (arg.type === "Property") {
      let key = arg.key.name;
      let value;

      if (arg.value.type === "Identifier") {
        value = extractTheVariableAtDeclaration(
          arg.value.name,
          programBody,
          nodeId
        );
      } else if (arg.value.type === "Literal") {
        value = arg.value.value;
      } else if (arg.value.type === "ObjectExpression") {
        value = traverseArguments(arg.value.properties, programBody, nodeId);
      } else if (arg.value.type === "MemberExpression") {
        value = traverseMemberExpressionValue(arg.value);
      } else if (arg.value.type === "ArrayExpression") {
        value = arg.value.elements.map((element) => {
          if (element.type === "ObjectExpression") {
            return traverseArguments(element.properties, programBody, nodeId);
          }
        });
      }
      result[key] = value;
    }
  });

  return result;
}

const findTheImmediateSchemaBeforeGivenNode = (
  nodeId,
  programBody,
  jsSchemaName
) => {
  // reverse loop
  for (let x = nodeId - 1; x >= 0; x--) {
    const thisNode = programBody[x];

    // it could also be a variable reassignment
    if (thisNode.type === "ExpressionStatement") {
      const thisNodeExpression = thisNode.expression;
      if (
        thisNodeExpression.type === "AssignmentExpression" &&
        thisNodeExpression.left.name === jsSchemaName
      ) {
        console.log("found the schema reassignment");
        const model = traverseArguments(
          thisNodeExpression.right.arguments[0].properties,
          programBody,
          nodeId
        );
        return model;
      }
    } else {
      const thisNodeDeclarations = thisNode.declarations;
      if (!thisNodeDeclarations) {
        console.log("no declarations");
        continue;
      }
      for (let y = 0; y < thisNodeDeclarations.length; y++) {
        const currentDeclaration = thisNodeDeclarations[y];

        if (
          currentDeclaration.type === "VariableDeclarator" &&
          currentDeclaration.id.name === jsSchemaName
        ) {
          const model = traverseArguments(
            currentDeclaration.init.arguments[0].properties,
            programBody,
            nodeId
          );

          return model;
        }
      }
    }
  }
};

const extractModelFromExpressionStatement = (expression) => {
  // this line is for finding the model declaration
  // it works for "module.exports =  mongoose.model("Admins", AdminSchema);"
  if (expression.type === "AssignmentExpression") {
    if (
      expression.right.type === "CallExpression" &&
      expression.right.callee.type === "MemberExpression" &&
      expression.right.callee.object.name === "mongoose" &&
      expression.right.callee.property.name === "model"
    ) {
      const modelName = expression.right.arguments[0].value;
      const jsSchemaName = expression.right.arguments[1].name;
      return {
        model: modelName,
        jsSchemaName,
      };
    } else if (expression.right.type === "LogicalExpression") {
      // this line is for finding the model declaration
      // this works for "module.exports = mongoose.models.Admins || mongoose.model("Admins", AdminSchema);"
      // idk why someone will do this kind of export. may god help them.
      if (expression.right.right.type === "CallExpression") {
        return extractModelFromCallExpression(expression.right.right);
      }
    }
  }
};

const extractModelFromCallExpression = (expression) => {
  if (
    expression.type === "CallExpression" &&
    expression.callee.type === "MemberExpression" &&
    expression.callee.object.name === "mongoose" &&
    expression.callee.property.name === "model"
  ) {
    const modelName = expression.arguments[0].value;
    const jsSchemaName = expression.arguments[1].name;
    return {
      model: modelName,
      jsSchemaName,
    };
  }
};

const extractTheVariableAtDeclaration = (name, programBody, nodeId) => {
  console.log("extracting the variable", nodeId);
  const mongooseTypes = [
    "String",
    "Number",
    "Date",
    "Buffer",
    "Boolean",
    "Mixed",
    "ObjectId",
    "Array",
  ];

  if (mongooseTypes.includes(name)) {
    return name;
  }

  for (let x = nodeId; x >= 0; x--) {
    const thisNode = programBody[x];
    if (thisNode.type === "VariableDeclaration") {
      for (let y = 0; y < thisNode.declarations.length; y++) {
        const currentDeclaration = thisNode.declarations[y];
        if (currentDeclaration.id.name === name) {
          console.log("found the variable");
          return traverseArguments(
            currentDeclaration.init.properties,
            programBody,
            nodeId
          );
        }
      }
    }
  }
};

const extractModel = (fileContent) => {
  // parse model string
  const ast = parse(fileContent, {
    sourceType: "module",
  });

  fs.writeFileSync("ast.json", JSON.stringify(ast, null, 2));

  // filtering the model names
  const models = [];
  const programBody = ast.body;
  for (let x = 0; x < programBody.length; x++) {
    const thisNode = programBody[x];
    if (thisNode.declarations) {
      // this line is for finding the model declaration
      // it works for "const Post = mongoose.model("Post", postSchema);"
      const thisNodeDeclarations = thisNode.declarations;
      for (let y = 0; y < thisNodeDeclarations.length; y++) {
        const currentDeclaration = thisNodeDeclarations[y];
        if (currentDeclaration.type === "VariableDeclarator") {
          const nodeId = x;

          const model = extractModelFromCallExpression(currentDeclaration.init);
          /**
           * with this jsSchemaName, there could be multiple declarations
           * we need to find the immediate before declaration
           */
          if (model) {
            const schema = findTheImmediateSchemaBeforeGivenNode(
              nodeId,
              programBody,
              model.jsSchemaName
            );
            models.push({
              model: model.model,
              jsSchemaName: model.jsSchemaName,
              schema: schema,
              nodeId,
            });
          }
        }
      }
    } else if (thisNode.type === "ExpressionStatement") {
      const model = extractModelFromExpressionStatement(thisNode.expression);
      if (model) {
        const nodeId = x;
        const schema = findTheImmediateSchemaBeforeGivenNode(
          nodeId,
          programBody,
          model.jsSchemaName
        );
        models.push({
          model: model.model,
          jsSchemaName: model.jsSchemaName,
          schema: schema,
          nodeId,
        });
      }
    }
  }

  // fs.writeFileSync("ast.json", JSON.stringify(models, null, 2));

  return models;
};

if (process.env.NODE_ENV === "dev") {
  const result = extractModel(`

  import mongoose from "mongoose";
const Schema = mongoose.Schema;
let UserSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  date: {
    type: Date,
    default: Date.now,
  },
});
const User = mongoose.model("User", UserSchema);

  `);
  console.log(JSON.stringify(result, null, 2));
}

export default extractModel;
