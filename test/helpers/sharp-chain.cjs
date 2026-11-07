'use strict';

const sharp = require('sharp');

module.exports = ({ input, steps, terminal }) => steps
  .reduce((image, step) => image[step.method](...step.args), sharp(...input))[terminal.method](...terminal.args);
